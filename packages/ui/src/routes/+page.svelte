<script lang="ts">
  import { onMount, type Component } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { ws } from "$lib/store.svelte";
  import { brand } from "$lib/brand.generated";
  import Titlebar from "$lib/components/Titlebar.svelte";
  import ProjectTransition from "$lib/components/ProjectTransition.svelte";
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
    try {
      const win = getCurrentWindow();
      void win
        .onCloseRequested(async (event) => {
          event.preventDefault();
          try {
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
</script>

<svelte:window onkeydown={onKey} />

<svelte:head><title>{brand.productName}</title></svelte:head>

<Tooltip.Provider delayDuration={250} disableHoverableContent>
  <div class="flex h-screen w-screen flex-col overflow-hidden">
    <Titlebar />
    <div class="min-h-0 flex-1 overflow-hidden">
      {#if !ws.ready}
        <div class="grid h-full place-items-center text-sm text-fg-subtle">loading…</div>
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
        <div class="grid h-full place-items-center px-8 text-center">
          <div>
            <h1 class="mb-2 text-lg font-semibold text-red-400">Storage error</h1>
            <p class="mx-auto mb-4 max-w-md text-sm text-fg-muted">
              The embedded RedDB store didn't come up: <span class="mono">{ws.loadError}</span>
            </p>
            <Button onclick={() => ws.retry()} size="xs">Retry</Button>
          </div>
        </div>
      {:else}
        <div class="flex h-full w-full overflow-hidden">
          <IconBar />
          {#if ws.view === "home"}
            <div class="flex-1 overflow-hidden"><HomeView /></div>
          {:else if ws.view === "database" && ws.redUiEnabled}
            <div class="flex-1 overflow-hidden">
              {#if RedUiDatabaseViewComponent}
                <RedUiDatabaseViewComponent />
              {:else if lazyLoadError}
                <div class="grid h-full place-items-center text-sm text-red-400">{lazyLoadError}</div>
              {:else}
                <div class="grid h-full place-items-center text-sm text-fg-subtle">loading…</div>
              {/if}
            </div>
          {:else if ws.view === "settings"}
            <div class="flex-1 overflow-hidden">
              {#if SettingsViewComponent}
                <SettingsViewComponent />
              {:else if lazyLoadError}
                <div class="grid h-full place-items-center text-sm text-red-400">{lazyLoadError}</div>
              {:else}
                <div class="grid h-full place-items-center text-sm text-fg-subtle">loading…</div>
              {/if}
            </div>
          {:else}
            <div
              bind:this={sidebarWrapEl}
              class="shrink-0 overflow-hidden"
              style="width: {sidebarPx}px"
            >
              <Sidebar />
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
                <RequestPanel />
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
                <ResponsePanel />
              </div>
            </div>
          {/if}
        </div>
        {#if cmdOpen && CommandPaletteComponent}
          <CommandPaletteComponent bind:open={cmdOpen} />
        {/if}
      {/if}
    </div>
  </div>
  {#if ws.transitioning}
    <ProjectTransition />
  {/if}
</Tooltip.Provider>
