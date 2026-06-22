<script lang="ts">
  import { onMount } from "svelte";
  import { ws } from "$lib/store.svelte";
  import { brand } from "$lib/brand.generated";
  import Titlebar from "$lib/components/Titlebar.svelte";
  import ProjectTransition from "$lib/components/ProjectTransition.svelte";
  import IconBar from "$lib/components/IconBar.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import RequestPanel from "$lib/components/RequestPanel.svelte";
  import ResponsePanel from "$lib/components/ResponsePanel.svelte";
  import HomeView from "$lib/components/HomeView.svelte";
  import SettingsView from "$lib/components/SettingsView.svelte";
  import ProjectSelector from "$lib/components/ProjectSelector.svelte";
  import CommandPalette from "$lib/components/ui/CommandPalette.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";

  let cmdOpen = $state(false);

  onMount(() => {
    void ws.init();
  });

  function onKey(e: KeyboardEvent) {
    if (ws.screen !== "app") return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      cmdOpen = !cmdOpen;
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
            <div class="flex-1 overflow-hidden"><SettingsView /></div>
          {:else}
            <Sidebar />
            <div class="grid flex-1 grid-cols-2 overflow-hidden">
              <RequestPanel />
              <ResponsePanel />
            </div>
          {/if}
        </div>
        <CommandPalette bind:open={cmdOpen} />
      {/if}
    </div>
  </div>
  {#if ws.transitioning}
    <ProjectTransition />
  {/if}
</Tooltip.Provider>
