<script lang="ts">
  import { onMount, type Component } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { ws } from "$lib/store.svelte";
  import { brand } from "$lib/brand.generated";
  import Titlebar from "$lib/components/Titlebar.svelte";
  import ClosingOverlay from "$lib/components/ClosingOverlay.svelte";
  import ProjectTransition from "$lib/components/ProjectTransition.svelte";
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
  let SettingsViewComponent = $state<Component | null>(null);
  let RedUiDatabaseViewComponent = $state<Component | null>(null);
  let CommandPaletteComponent = $state<Component<{ open?: boolean }> | null>(
    null
  );

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
    void ws.init();

    // Durability net for the debounced autosave: a pending edit must reach reddb before
    // the app loses focus, hides, or closes — otherwise closing within the debounce
    // window drops it. flushSave() is a no-op when nothing is pending, so these are cheap.
    const flush = () => void ws.flushSave();
    const onVisibility = () => {
      if (document.hidden) flush();
    };
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", onVisibility);

    // Intercept the window close so the flush lands while reddb is still alive (the Rust
    // side reaps the sidecar on Destroyed, not CloseRequested). This is best-effort:
    // Rust also arms a native watchdog on CloseRequested, so a wedged webview cannot
    // trap the OS close button behind preventDefault().
    let unlistenClose: (() => void) | undefined;
    let closeStarted = false;
    try {
      const win = getCurrentWindow();
      void win
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
        .then((u) => (unlistenClose = u));
    } catch {
      /* not running inside the Tauri shell (browser dev) — no window to guard */
    }

    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      unlistenClose?.();
    };
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
       black screen. The user gets an actionable message + the full
       error in the DeveloperConsole (search for "boundary caught")
       so a bug report has what it needs. -->
  <div class="grid h-full place-items-center px-8 text-center">
    <div class="max-w-lg">
      <h1 class="mb-2 text-lg font-semibold text-red-400">Something went wrong</h1>
      <p class="mb-4 text-sm text-fg-muted">
        A rendering error stopped the layout from mounting. The full stack trace landed
        in the DeveloperConsole (right-hand panel). Try the actions below, or file a
        bug with the error text.
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

<Tooltip.Provider delayDuration={250} disableHoverableContent>
  <div class="flex h-screen w-screen flex-col overflow-hidden">
    <Titlebar />
    <div class="min-h-0 flex-1 overflow-hidden">
      <svelte:boundary
        failed={pageFailed}
        onerror={(err) => appLog("error", `boundary caught: ${err instanceof Error ? err.stack : err}`)}
      >
        {#if !ws.ready}
        <div class="grid h-full place-items-center text-sm text-fg-subtle">loading…</div>
      {:else if ws.loading}
        <!-- Visible "Opening project…" overlay. Replaces the dreaded black
             iris with a real, labelled progress screen: shows the current
             step, a step-by-step log so the user can see where it stalled,
             and the elapsed time. Without this the user gets a silent black
             window and has no way to know whether the app is hung or
             just slow. -->
        <div class="grid h-full place-items-center px-8 text-center">
          <div class="w-full max-w-md">
            <div class="mx-auto mb-4 grid h-10 w-10 place-items-center rounded-full bg-[var(--color-brand)]/15 text-[var(--color-brand)]">
              <span class="mono text-xs font-bold">
                {Math.floor((Date.now() - ws.loading.startedAt) / 1000)}s
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
              <Button onclick={() => ws.retry()} size="xs" variant="outline">
                Retry
              </Button>
              <Button
                onclick={() => ws.rebuildStore()}
                size="xs"
                variant="outline"
                title="Back up app.rdb and recreate from scratch — keeps a .incompatible backup next to the file so nothing is lost"
              >
                Rebuild database
              </Button>
              <Button
                onclick={() => ws.backToSelector()}
                size="xs"
                variant="ghost"
              >
                Choose another project
              </Button>
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
  </div>
  {#if ws.transitioning}
    <ProjectTransition />
  {/if}
  {#if ws.closing}
    <ClosingOverlay />
  {/if}
</Tooltip.Provider>
