<script lang="ts">
  import { onMount } from "svelte";
  import { ws } from "$lib/store.svelte";
  import { brand } from "$lib/brand.generated";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import RequestPanel from "$lib/components/RequestPanel.svelte";
  import ResponsePanel from "$lib/components/ResponsePanel.svelte";
  import Dashboard from "$lib/components/Dashboard.svelte";
  import ProjectSelector from "$lib/components/ProjectSelector.svelte";
  import { Tooltip } from "bits-ui";

  onMount(() => {
    void ws.init();
  });
</script>

<svelte:head><title>{brand.productName}</title></svelte:head>

<Tooltip.Provider delayDuration={250} disableHoverableContent>
  {#if !ws.ready}
    <div class="grid h-screen place-items-center text-sm text-fg-subtle">loading…</div>
  {:else if ws.bridgeMissing}
    <div class="grid h-screen place-items-center px-8 text-center">
      <div>
        <h1 class="mb-2 text-lg font-semibold text-fg-strong">{brand.productName}</h1>
        <p class="max-w-md text-sm text-fg-muted">
          This UI talks to a native bridge (engine + RedDB + keychain) that only exists inside
          the desktop shell. Run <code class="mono text-[var(--color-accent)]"
            >pnpm desktop:dev</code
          > to launch the app.
        </p>
      </div>
    </div>
  {:else if ws.screen === "selector"}
    <ProjectSelector />
  {:else if ws.loadError}
    <div class="grid h-screen place-items-center px-8 text-center">
      <div>
        <h1 class="mb-2 text-lg font-semibold text-red-400">Storage error</h1>
        <p class="mx-auto mb-4 max-w-md text-sm text-fg-muted">
          The embedded RedDB store didn't come up: <span class="mono">{ws.loadError}</span>
        </p>
        <button onclick={() => ws.retry()} class="btn btn-primary">Retry</button>
      </div>
    </div>
  {:else}
    <div class="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      {#if ws.view === "dashboard"}
        <div class="flex-1 overflow-hidden"><Dashboard /></div>
      {:else}
        <div class="grid flex-1 grid-cols-2 overflow-hidden">
          <RequestPanel />
          <ResponsePanel />
        </div>
      {/if}
    </div>
  {/if}
</Tooltip.Provider>
