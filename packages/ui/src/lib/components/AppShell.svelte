<script lang="ts">
  import { onMount, type Component } from "svelte";
  import { ws } from "$lib/store.svelte";
  import { brand } from "$lib/brand.generated";
  import ClosingOverlay from "$lib/components/ClosingOverlay.svelte";
  import DeveloperConsole from "$lib/components/DeveloperConsole.svelte";
  import IconBar from "$lib/components/IconBar.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import RequestPanel from "$lib/components/RequestPanel.svelte";
  import ResponsePanel from "$lib/components/ResponsePanel.svelte";
  import HomeView from "$lib/components/HomeView.svelte";
  import ProjectSelector from "$lib/components/ProjectSelector.svelte";
  import { appLog } from "$lib/log";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";

  let cmdOpen = $state(false);
  let lazyLoadError = $state("");
  let mountedAt = $state(Date.now());
  let SettingsViewComponent = $state<Component | null>(null);
  let RedUiDatabaseViewComponent = $state<Component | null>(null);
  let CommandPaletteComponent = $state<Component<{ open?: boolean }> | null>(
    null
  );
  let now = $state(Date.now());
  const STARTUP_RECOVERY_MS = 15_000;
  const FAILSAFE_OPEN_RECOVERY_MS = 30_000;

  async function currentWindow() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow();
  }

  function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.stack ?? error.message;
    return String(error);
  }

  function recoverFromBootError(source: string, error: unknown) {
    const detail = errorMessage(error);
    appLog("error", `${source}: ${detail}`);
    if (ws.screen !== "app" || (!ws.loading && !ws.transitioning)) return;
    queueMicrotask(() => {
      if (ws.screen !== "app" || (!ws.loading && !ws.transitioning)) return;
      ws.forceOpenRecovery(`${source}: ${detail}`);
    });
  }

  function waitForPaint(): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      setTimeout(finish, 80);
      requestAnimationFrame(() => requestAnimationFrame(finish));
    });
  }

  onMount(() => {
    mountedAt = Date.now();
    void ws.init();
    const tick = setInterval(() => {
      now = Date.now();
    }, 1000);

    // Durability net for the debounced autosave: a pending edit must reach reddb before
    // the app loses focus, hides, or closes — otherwise closing within the debounce
    // window drops it. flushSave() is a no-op when nothing is pending, so these are cheap.
    const flush = () => void ws.flushSave();
    const onVisibility = () => {
      if (document.hidden) flush();
    };
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", onVisibility);
    const onGlobalError = (event: ErrorEvent) => {
      recoverFromBootError("Project boot crashed", event.error ?? event.message);
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      recoverFromBootError("Project boot promise rejected", event.reason);
    };
    window.addEventListener("error", onGlobalError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    // Intercept the window close so the flush lands while reddb is still alive (the Rust
    // side reaps the sidecar on Destroyed, not CloseRequested). This is best-effort:
    // Rust also arms a native watchdog on CloseRequested, so a wedged webview cannot
    // trap the OS close button behind preventDefault().
    let unlistenClose: (() => void) | undefined;
    let closeStarted = false;
    void currentWindow()
      .then((win) =>
        win
        .onCloseRequested(async (event) => {
          event.preventDefault();
          ws.beginClosing();
          if (closeStarted) return;
          closeStarted = true;
          try {
            await waitForPaint();
            await Promise.race([
              ws.flushSave(),
              new Promise((r) => setTimeout(r, 2000)),
            ]);
          } catch {
            /* never block the close on a save error */
          }
          await win.destroy();
        })
      )
      .then((u) => (unlistenClose = u))
      .catch(() => {
        /* not running inside the Tauri shell (browser dev) — no window to guard */
      });

    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("error", onGlobalError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      clearInterval(tick);
      unlistenClose?.();
    };
  });

  const loadElapsedMs = $derived(
    ws.loading ? Math.max(0, now - ws.loading.startedAt) : 0
  );
  const startupElapsedMs = $derived(Math.max(0, now - mountedAt));
  const startupElapsedSeconds = $derived(Math.floor(startupElapsedMs / 1000));
  const loadElapsedSeconds = $derived(Math.floor(loadElapsedMs / 1000));
  const loadIsSlow = $derived(loadElapsedMs >= 10_000);
  const showRecoveryDock = $derived(
    ws.screen === "app" &&
      !ws.closing &&
      (Boolean(ws.loading) || Boolean(ws.loadError) || ws.transitioning)
  );

  $effect(() => {
    if (ws.ready || ws.loadError) return;
    if (startupElapsedMs < STARTUP_RECOVERY_MS) return;
    queueMicrotask(() => {
      if (ws.ready || ws.loadError) return;
      ws.forceOpenRecovery(
        `Startup timed out before project info became ready after ${startupElapsedSeconds}s.`
      );
    });
  });

  $effect(() => {
    const loading = ws.loading;
    if (!loading || ws.loadError) return;
    if (now - loading.startedAt < FAILSAFE_OPEN_RECOVERY_MS) return;
    queueMicrotask(() => {
      if (!ws.loading || ws.loadError) return;
      ws.forceOpenRecovery(
        `Project opening hit the failsafe after ${Math.floor(
          (Date.now() - loading.startedAt) / 1000
        )}s at step: ${loading.step}.`
      );
    });
  });

  // Autosave: persist the active request a short beat after the user stops
  // editing (URL, params, headers, body, auth…), so edits survive a reload or
  // project switch even without an explicit Ctrl-S. Selecting a different
  // request only resets the baseline — it never triggers a save.
  let lastReqId: string | null = null;
  let lastReqSnap = "";
  $effect(() => {
    const req = ws.activeReq;
    if (!req || !ws.activeColId) {
      lastReqId = null;
      lastReqSnap = "";
      return;
    }
    const snap = JSON.stringify($state.snapshot(req)); // deep-tracks every field
    if (req.id !== lastReqId) {
      lastReqId = req.id;
      lastReqSnap = snap;
      return;
    }
    if (snap === lastReqSnap) return;
    lastReqSnap = snap;
    ws.scheduleSave();
  });

  // Resizable split between the request and response panels (#7).
  let splitEl = $state<HTMLDivElement | undefined>();
  let reqPct = $state(50);
  let dragging = $state(false);
  function startResize(e: MouseEvent) {
    e.preventDefault();
    dragging = true;
    const onMove = (ev: MouseEvent) => {
      if (!splitEl) return;
      const r = splitEl.getBoundingClientRect();
      const pct = ((ev.clientX - r.left) / r.width) * 100;
      reqPct = Math.min(80, Math.max(20, pct));
    };
    const onUp = () => {
      dragging = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Resizable split between the sidebar (request list) and the middle column — mirrors the
  // request/response divider above, but the sidebar is sized in pixels (a fixed-ish rail).
  let sidebarWrapEl = $state<HTMLDivElement | undefined>();
  let sidebarPx = $state(256); // matches the old hard-coded w-64
  let sidebarDragging = $state(false);
  function startSidebarResize(e: MouseEvent) {
    e.preventDefault();
    sidebarDragging = true;
    const onMove = (ev: MouseEvent) => {
      if (!sidebarWrapEl) return;
      const left = sidebarWrapEl.getBoundingClientRect().left;
      sidebarPx = Math.min(560, Math.max(180, ev.clientX - left));
    };
    const onUp = () => {
      sidebarDragging = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function reportLazyLoadFailure(label: string, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    lazyLoadError = `Could not load ${label}.`;
    appLog("error", `lazy load ${label} failed: ${detail}`);
  }

  async function loadSettingsView() {
    if (SettingsViewComponent) return;
    try {
      SettingsViewComponent = (
        await import("$lib/components/SettingsView.svelte")
      ).default;
      lazyLoadError = "";
    } catch (error) {
      reportLazyLoadFailure("settings", error);
    }
  }

  async function loadRedUiDatabaseView() {
    if (RedUiDatabaseViewComponent) return;
    try {
      RedUiDatabaseViewComponent = (
        await import("$lib/components/RedUiDatabaseView.svelte")
      ).default;
      lazyLoadError = "";
    } catch (error) {
      reportLazyLoadFailure("database", error);
    }
  }

  async function openCommandPalette() {
    if (!CommandPaletteComponent) {
      try {
        CommandPaletteComponent = (
          await import("$lib/components/ui/CommandPalette.svelte")
        ).default;
      } catch (error) {
        reportLazyLoadFailure("command palette", error);
        return;
      }
    }
    cmdOpen = true;
  }

  $effect(() => {
    if (ws.view === "settings") void loadSettingsView();
    if (ws.view === "database") void loadRedUiDatabaseView();
  });

  function onKey(e: KeyboardEvent) {
    if (ws.screen !== "app") return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && ["k", "p"].includes(e.key.toLowerCase())) {
      e.preventDefault();
      if (cmdOpen) cmdOpen = false;
      else void openCommandPalette();
    } else if (mod && e.key === "Enter" && ws.activeReq && !ws.sending) {
      e.preventDefault();
      void ws.send();
    }
  }

  /**
   * Translate a raw RedDB / red-request load error into user-facing copy.
   * The error string is still shown verbatim below for support requests, but
   * the title + summary tell the user what kind of failure this is so they can
   * pick the right recovery button.
   */
  function classifyLoadError(message: string): {
    title: string;
    summary: string;
  } {
    const m = message.toLowerCase();
    if (/model mismatch|expected kv|incompatible/.test(m)) {
      return {
        title: "Database format is outdated",
        summary:
          "This project's app.rdb was created by a much older version of red-request. Rebuild to migrate to the current schema — the old file is backed up next to it.",
      };
    }
    if (/sidecar|reddb_url|connect|connection refused|unreachable|spawn/i.test(m)) {
      return {
        title: "Can't reach the embedded database",
        summary:
          "The RedDB sidecar didn't come up. Try Retry; if it keeps failing, restart the app or rebuild the database.",
      };
    }
    if (/permission|denied|eacces/.test(m)) {
      return {
        title: "Permission denied",
        summary:
          "red-request can't read or write this app.rdb. Check the file's permissions or pick a different project folder.",
      };
    }
    if (/no such file|not found|missing/.test(m)) {
      return {
        title: "Database file is missing",
        summary:
          "The app.rdb for this project no longer exists. Rebuild to create a fresh one.",
      };
    }
    return {
      title: "Storage error",
      summary:
        "The embedded RedDB store didn't come up. Retry first; if the error keeps repeating, rebuild the database or pick a different project.",
    };
  }
</script>

<svelte:window onkeydown={onKey} />

<svelte:head><title>{brand.productName}</title></svelte:head>

{#snippet pageFailed(err: unknown, reset: () => void)}
  <!-- Last-resort screen: any uncaught error in the main app tree
       (a mounted RequestPanel with a stale profileId, a lazy import
       that resolves to undefined, anything) lands here instead of a
       black screen. The user gets an actionable message + visible
       error text so a bug report has what it needs. -->
  <div class="grid h-full place-items-center px-8 text-center">
    <div class="max-w-lg">
      <h1 class="mb-2 text-lg font-semibold text-red-400">Something went wrong</h1>
      <p class="mb-4 text-sm text-fg-muted">
        A rendering error stopped the layout from mounting. Try the actions below,
        or file a bug with the visible error text.
      </p>
      <pre
        class="mono mb-4 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-bg-1)] p-3 text-left text-[11px] text-fg-muted"
      >{err instanceof Error ? (err.stack ?? err.message) : String(err)}</pre>
      <div class="flex flex-wrap items-center justify-center gap-2">
        <Button onclick={reset} size="xs" variant="outline">Retry render</Button>
        <Button
          onclick={() => {
            try {
              location.reload();
            } catch {
              /* webview shell will handle it */
            }
          }}
          size="xs"
          variant="ghost"
        >
          Reload window
        </Button>
      </div>
    </div>
  </div>
{/snippet}

{#snippet shellFailed(err: unknown, reset: () => void)}
  <!-- Root-shell fallback: this catches failures above the app panels
       (providers, tooltip/runtime wiring, shell-level effects). Titlebar lives
       outside this boundary, so window controls remain reachable even here. -->
  <div class="grid h-full place-items-center px-8 text-center">
    <div class="max-w-lg">
      <h1 class="mb-2 text-lg font-semibold text-red-400">Project shell failed</h1>
      <p class="mb-4 text-sm text-fg-muted">
        The project shell crashed before the workspace could render. Use the actions
        below instead of waiting on a blank window.
      </p>
      <pre
        class="mono mb-4 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-bg-1)] p-3 text-left text-[11px] text-fg-muted"
      >{err instanceof Error ? (err.stack ?? err.message) : String(err)}</pre>
      <div class="flex flex-wrap items-center justify-center gap-2">
        <Button onclick={reset} size="xs" variant="outline">Retry shell</Button>
        <Button onclick={() => ws.exportCrashReport()} size="xs" variant="outline">
          Export crash report
        </Button>
        <Button onclick={() => ws.backToSelector()} size="xs" variant="ghost">
          Choose another project
        </Button>
        <Button
          onclick={() => {
            try {
              location.reload();
            } catch {
              /* webview shell will handle it */
            }
          }}
          size="xs"
          variant="ghost"
        >
          Reload window
        </Button>
      </div>
    </div>
  </div>
{/snippet}

{#snippet homeFailed(err: unknown)}
  <div class="grid h-full place-items-center px-8 text-center text-sm">
    <div>
      <p class="mb-1 font-semibold text-red-400">Home failed to render</p>
      <pre class="mono max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-fg-faint">{err instanceof Error ? err.message : String(err)}</pre>
    </div>
  </div>
{/snippet}

{#snippet dbFailed(err: unknown)}
  <div class="grid h-full place-items-center px-8 text-center text-sm">
    <div>
      <p class="mb-1 font-semibold text-red-400">Database view failed</p>
      <pre class="mono max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-fg-faint">{err instanceof Error ? err.message : String(err)}</pre>
    </div>
  </div>
{/snippet}

{#snippet settingsFailed(err: unknown)}
  <div class="grid h-full place-items-center px-8 text-center text-sm">
    <div>
      <p class="mb-1 font-semibold text-red-400">Settings failed to render</p>
      <pre class="mono max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-fg-faint">{err instanceof Error ? err.message : String(err)}</pre>
    </div>
  </div>
{/snippet}

{#snippet sidebarFailed()}
  <div class="grid h-full place-items-center px-2 text-center text-xs text-red-400">
    Sidebar failed
  </div>
{/snippet}

{#snippet requestFailed(err: unknown)}
  <div class="grid h-full place-items-center px-4 text-center text-sm">
    <div>
      <p class="mb-1 font-semibold text-red-400">Request panel failed</p>
      <pre class="mono max-h-40 overflow-auto whitespace-pre-wrap text-left text-[11px] text-fg-faint">{err instanceof Error ? (err.stack ?? err.message) : String(err)}</pre>
    </div>
  </div>
{/snippet}

{#snippet responseFailed(err: unknown)}
  <div class="grid h-full place-items-center px-4 text-center text-sm">
    <div>
      <p class="mb-1 font-semibold text-red-400">Response panel failed</p>
      <pre class="mono max-h-40 overflow-auto whitespace-pre-wrap text-left text-[11px] text-fg-faint">{err instanceof Error ? (err.stack ?? err.message) : String(err)}</pre>
    </div>
  </div>
{/snippet}

{#snippet loadingRecoveryActions()}
  <Button onclick={() => ws.backToSelector()} size="xs" variant="outline">
    Choose another project
  </Button>
  <Button onclick={() => ws.retry()} size="xs" variant="outline">
    Retry opening
  </Button>
  <Button onclick={() => ws.exportCrashReport()} size="xs" variant="ghost">
    Export crash report
  </Button>
  <Button
    onclick={() =>
      ws.forceOpenRecovery(
        `Project opening was stopped after ${loadElapsedSeconds}s at step: ${ws.loading?.step ?? "unknown"}.`
      )}
    size="xs"
    variant="ghost"
  >
    Stop waiting
  </Button>
  {#if ws.project?.project_dir}
    <Button
      onclick={() => ws.rebuildStore()}
      size="xs"
      variant="ghost"
      title="Back up app.rdb and recreate from scratch"
    >
      Rebuild database
    </Button>
  {/if}
  {#if ws.recoveryProjectDir}
    <Button
      onclick={() => {
        if (
          confirm(
            "Delete this project's .red/request data and return to the project picker? This cannot be undone."
          )
        )
          void ws.deleteProjectData();
      }}
      size="xs"
      variant="ghost"
      title="Deletes only this project's .red/request data, not the source folder"
    >
      Delete local data
    </Button>
  {/if}
{/snippet}

{#snippet loadErrorRecoveryActions()}
  <Button onclick={() => ws.retry()} size="xs" variant="outline">
    Retry
  </Button>
  <Button onclick={() => ws.exportCrashReport()} size="xs" variant="outline">
    Export crash report
  </Button>
  {#if ws.project?.project_dir}
    <Button
      onclick={() => ws.rebuildStore()}
      size="xs"
      variant="outline"
      title="Back up app.rdb and recreate from scratch — keeps a .incompatible backup next to the file so nothing is lost"
    >
      Rebuild database
    </Button>
  {/if}
  <Button onclick={() => ws.backToSelector()} size="xs" variant="ghost">
    Choose another project
  </Button>
  {#if ws.project?.project_dir}
    <Button onclick={() => ws.forgetProject()} size="xs" variant="ghost">
      Forget project
    </Button>
  {/if}
  {#if ws.recoveryProjectDir}
    <Button
      onclick={() => {
        if (
          confirm(
            "Delete this project's .red/request data and return to the project picker? This cannot be undone."
          )
        )
          void ws.deleteProjectData();
      }}
      size="xs"
      variant="ghost"
      title="Deletes only this project's .red/request data, not the source folder"
    >
      Delete local data
    </Button>
  {/if}
{/snippet}

{#snippet emptyWorkspaceOnboarding()}
  <div class="grid h-full place-items-center px-8 text-center">
    <div class="max-w-lg">
      <p class="label mb-3 text-[var(--color-brand)]">Project ready</p>
      <h1 class="mb-2 text-lg font-semibold text-fg-strong">Start this project</h1>
      <p class="mx-auto mb-5 max-w-md text-sm leading-6 text-fg-muted">
        This is a fresh Red Request workspace. Create a collection to start
        organizing requests, or choose another folder if this is not the project
        you meant to open.
      </p>
      <div class="flex flex-wrap items-center justify-center gap-2">
        <Button onclick={() => ws.addCollection()} size="xs">
          Create collection
        </Button>
        <Button onclick={() => ws.backToSelector()} size="xs" variant="ghost">
          Choose another project
        </Button>
      </div>
      {#if ws.project}
        <p class="mono mt-4 break-all text-xs text-fg-faint">{ws.project.db_path}</p>
      {/if}
    </div>
  </div>
{/snippet}

<div class="h-full overflow-hidden">
    <svelte:boundary
      failed={shellFailed}
      onerror={(err) => appLog("error", `shell boundary caught: ${err instanceof Error ? err.stack : err}`)}
    >
      <Tooltip.Provider delayDuration={250} disableHoverableContent>
        <div class="h-full overflow-hidden">
      <svelte:boundary
        failed={pageFailed}
        onerror={(err) => appLog("error", `boundary caught: ${err instanceof Error ? err.stack : err}`)}
      >
        {#if !ws.ready}
        <div class="grid h-full place-items-center text-sm text-fg-subtle">loading…</div>
      {:else if ws.loading && !ws.loadError}
        <!-- Visible "Opening project…" shell. Replaces the old black
             transition with a real, labelled progress screen: shows the current
             step, a step-by-step log so the user can see where it stalled,
             and the elapsed time. Without this the user gets a silent black
             window and has no way to know whether the app is hung or
             just slow. -->
        <div class="grid h-full place-items-center px-8 text-center">
          <div class="w-full max-w-md">
            <div class="mx-auto mb-4 grid h-10 w-10 place-items-center rounded-full bg-[var(--color-brand)]/15 text-[var(--color-brand)]">
              <span class="mono text-xs font-bold">
                {loadElapsedSeconds}s
              </span>
            </div>
            <h1 class="mb-1 text-base font-semibold text-fg-strong">
              {ws.transitioning ? "Opening project…" : "Working…"}
            </h1>
            <p class="mb-4 text-sm text-fg-muted">{ws.loading.step}</p>
            {#if ws.loading.detail}
              <p class="mono mb-4 break-all rounded bg-[var(--color-bg-1)] px-3 py-2 text-[11px] text-fg-faint">
                {ws.loading.detail}
              </p>
            {/if}
            <ol
              class="mx-auto max-h-48 w-full max-w-sm space-y-1 overflow-auto rounded border border-border bg-[var(--color-bg-1)] p-3 text-left text-[11px]"
            >
              {#each ws.loading.log as entry, i (i)}
                <li class="flex gap-2">
                  <span class="mono shrink-0 text-fg-faint">
                    +{Math.max(0, Math.floor((entry.ts - ws.loading.startedAt) / 100)) / 10}s
                  </span>
                  <span class="text-fg-muted">{entry.step}</span>
                </li>
              {/each}
            </ol>
            {#if loadIsSlow}
              <div class="mx-auto mt-4 max-w-sm rounded border border-red-500/30 bg-red-500/10 p-3 text-left">
                <p class="mb-1 text-xs font-semibold text-red-300">
                  This is taking longer than expected.
                </p>
                <p class="text-[11px] leading-5 text-fg-muted">
                  You can stop the stuck open, export a crash report, retry the same target,
                  or return to the project picker without waiting for the old operation.
                </p>
              </div>
            {/if}
            <div class="mt-4 flex flex-wrap items-center justify-center gap-2">
              {@render loadingRecoveryActions()}
            </div>
          </div>
        </div>
      {:else if ws.bridgeMissing}
        <div class="grid h-full place-items-center px-8 text-center">
          <div>
            <h1 class="mb-2 text-lg font-semibold text-fg-strong">{brand.productName}</h1>
            <p class="max-w-md text-sm text-fg-muted">
              This UI talks to a native bridge (engine + RedDB + keychain) that only exists inside
              the desktop shell. Run <code class="mono text-[var(--color-brand)]"
                >pnpm desktop:dev</code
              > to launch the app.
            </p>
          </div>
        </div>
      {:else if ws.screen === "selector"}
        <ProjectSelector />
      {:else if ws.loadError}
        {@const hint = classifyLoadError(ws.loadError)}
        <div class="grid h-full place-items-center px-8 text-center">
          <div class="max-w-lg">
            <h1 class="mb-2 text-lg font-semibold text-red-400">{hint.title}</h1>
            <p class="mx-auto mb-1 max-w-md text-sm text-fg-muted">{hint.summary}</p>
            <p class="mono mx-auto mb-4 max-w-md text-xs text-fg-faint">
              {ws.loadError}
            </p>
            <div class="flex flex-wrap items-center justify-center gap-2">
              {@render loadErrorRecoveryActions()}
            </div>
            {#if ws.project}
              <p class="mt-4 text-xs text-fg-faint">
                Current project: <span class="mono">{ws.project.db_path}</span>
              </p>
            {/if}
          </div>
        </div>
      {:else}
        <div class="flex h-full w-full overflow-hidden">
          <IconBar />
          <div class="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div class="min-h-0 flex-1 overflow-hidden">
              {#if ws.view === "home"}
                <!-- Nested boundary per panel: if HomeView / RequestPanel /
                     ResponsePanel throws on mount, the parent boundary still
                     catches it but the message names the actual panel that
                     blew up — way more useful than "something went wrong" in
                     the full layout. The fallback uses `h-full` so it
                     actually fills its slot. -->
                <svelte:boundary
                  failed={homeFailed}
                  onerror={(err) => appLog("error", `HomeView boundary caught: ${err instanceof Error ? err.stack : err}`)}
                >
                  <div class="h-full overflow-hidden"><HomeView /></div>
                </svelte:boundary>
              {:else if ws.view === "database" && ws.redUiEnabled}
                <div class="h-full overflow-hidden">
                  {#if RedUiDatabaseViewComponent}
                    <svelte:boundary
                      failed={dbFailed}
                      onerror={(err) => appLog("error", `RedUiDatabaseView boundary caught: ${err instanceof Error ? err.stack : err}`)}
                    >
                      <RedUiDatabaseViewComponent />
                    </svelte:boundary>
                  {:else if lazyLoadError}
                    <div class="grid h-full place-items-center text-sm text-red-400">{lazyLoadError}</div>
                  {:else}
                    <div class="grid h-full place-items-center text-sm text-fg-subtle">loading…</div>
                  {/if}
                </div>
              {:else if ws.view === "settings"}
                <div class="h-full overflow-hidden">
                  {#if SettingsViewComponent}
                    <svelte:boundary
                      failed={settingsFailed}
                      onerror={(err) => appLog("error", `SettingsView boundary caught: ${err instanceof Error ? err.stack : err}`)}
                    >
                      <SettingsViewComponent />
                    </svelte:boundary>
                  {:else if lazyLoadError}
                    <div class="grid h-full place-items-center text-sm text-red-400">{lazyLoadError}</div>
                  {:else}
                    <div class="grid h-full place-items-center text-sm text-fg-subtle">loading…</div>
                  {/if}
                </div>
              {:else if ws.view === "requests" && ws.collections.length === 0}
                {@render emptyWorkspaceOnboarding()}
              {:else}
                <div class="flex h-full overflow-hidden">
                  <div
                    bind:this={sidebarWrapEl}
                    class="shrink-0 overflow-hidden"
                    style="width: {sidebarPx}px"
                  >
                    <svelte:boundary
                      failed={sidebarFailed}
                      onerror={(err) => appLog("error", `Sidebar boundary caught: ${err instanceof Error ? err.stack : err}`)}
                    >
                      <Sidebar />
                    </svelte:boundary>
                  </div>
                  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    tabindex="-1"
                    title="Drag to resize"
                    onmousedown={startSidebarResize}
                    class="w-1 shrink-0 cursor-col-resize bg-border transition hover:bg-[var(--color-brand)] {sidebarDragging
                      ? 'bg-[var(--color-brand)]'
                      : ''}"
                  ></div>
                  <div bind:this={splitEl} class="flex flex-1 overflow-hidden">
                    <div class="min-w-0 overflow-hidden" style="width: {reqPct}%">
                      <svelte:boundary
                        failed={requestFailed}
                        onerror={(err) => appLog("error", `RequestPanel boundary caught: ${err instanceof Error ? err.stack : err}`)}
                      >
                        <RequestPanel />
                      </svelte:boundary>
                    </div>
                    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      tabindex="-1"
                      title="Drag to resize"
                      onmousedown={startResize}
                      class="w-1 shrink-0 cursor-col-resize bg-border transition hover:bg-[var(--color-brand)] {dragging
                        ? 'bg-[var(--color-brand)]'
                        : ''}"
                    ></div>
                    <div class="min-w-0 flex-1 overflow-hidden">
                      <svelte:boundary
                        failed={responseFailed}
                        onerror={(err) => appLog("error", `ResponsePanel boundary caught: ${err instanceof Error ? err.stack : err}`)}
                      >
                        <ResponsePanel />
                      </svelte:boundary>
                    </div>
                  </div>
                </div>
              {/if}
            </div>
            <DeveloperConsole />
          </div>
        </div>
        {#if cmdOpen && CommandPaletteComponent}
          <CommandPaletteComponent bind:open={cmdOpen} />
        {/if}
      {/if}
      </svelte:boundary>
        </div>
        {#if showRecoveryDock}
          <div
            data-testid="project-recovery-dock"
            class="pointer-events-none fixed right-3 top-11 z-[950] max-w-[calc(100vw-1.5rem)] rounded-md border border-border bg-[var(--color-bg-0)]/95 px-3 py-2 shadow-xl backdrop-blur"
          >
            <div class="pointer-events-auto flex flex-wrap items-center gap-2">
              <span class="label mr-1">
                {#if ws.loadError}
                  Recovery
                {:else if ws.loading}
                  {ws.loading.step}
                {:else}
                  Opening project…
                {/if}
              </span>
              {#if ws.loadError}
                {@render loadErrorRecoveryActions()}
              {:else}
                {@render loadingRecoveryActions()}
              {/if}
            </div>
          </div>
        {/if}
        {#if ws.closing}
          <ClosingOverlay />
        {/if}
      </Tooltip.Provider>
    </svelte:boundary>
</div>
