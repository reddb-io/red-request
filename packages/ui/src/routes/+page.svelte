<script lang="ts">
  import { onMount, type Component } from "svelte";
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
  let CommandPaletteComponent = $state<Component<{ open?: boolean }> | null>(
    null
  );

  onMount(() => {
    void ws.init();
  });

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
  });

  function onKey(e: KeyboardEvent) {
    if (ws.screen !== "app") return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "k") {
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
            <Sidebar />
            <div class="grid flex-1 grid-cols-2 overflow-hidden">
              <RequestPanel />
              <ResponsePanel />
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
