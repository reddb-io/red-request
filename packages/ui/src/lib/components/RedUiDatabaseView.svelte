<script lang="ts">
  import { onMount } from "svelte";
  import { registerRedUiElement, type RedUiElement } from "@reddb-io/ui/embed";
  import Database from "@lucide/svelte/icons/database";
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import { ws } from "../store.svelte";
  import { reddbUrl } from "../rpc";
  import { createRedUiProvider } from "../red-ui-embed";
  import { Button } from "./ui/button/index.js";

  let host = $state<RedUiElement | null>(null);
  let status = $state<"loading" | "ready" | "error">("loading");
  let error = $state("");
  let endpoint = $state("");

  async function mountRedUi() {
    if (!host) return;
    status = "loading";
    error = "";
    try {
      await customElements.whenDefined("red-ui-app");
      endpoint = await reddbUrl();
      host.initialRoute = "/collections";
      host.theme = "dark";
      host.connectionProvider = createRedUiProvider(endpoint, ws.project?.db_path);
      status = "ready";
    } catch (e) {
      host.connectionProvider = null;
      error = e instanceof Error ? e.message : String(e);
      status = "error";
    }
  }

  onMount(() => {
    registerRedUiElement();
    void mountRedUi();
    return () => {
      if (host) host.connectionProvider = null;
    };
  });
</script>

<section class="flex h-full min-h-0 flex-col bg-[var(--color-bg-0)]">
  <header class="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
    <div class="grid h-7 w-7 place-items-center rounded-md bg-[var(--color-bg-2)] text-[var(--color-brand)]">
      <Database size={16} />
    </div>
    <div class="min-w-0 flex-1">
      <h1 class="text-sm font-semibold text-fg-strong">Database</h1>
      <p class="mono truncate text-[11px] text-fg-faint" title={ws.project?.db_path}>
        {ws.project?.db_path ?? endpoint}
      </p>
    </div>
    {#if status === "error"}
      <Button onclick={mountRedUi} variant="outline" size="xs">
        <RotateCw size={14} />
        Retry
      </Button>
    {/if}
  </header>

  <div class="relative min-h-0 flex-1 overflow-auto">
    <red-ui-app bind:this={host} class="block h-full min-h-full w-full"></red-ui-app>

    {#if status === "loading"}
      <div class="absolute inset-0 grid place-items-center bg-[var(--color-bg-0)]/80 text-sm text-fg-subtle">
        loading database…
      </div>
    {:else if status === "error"}
      <div class="absolute inset-0 grid place-items-center bg-[var(--color-bg-0)] px-8 text-center">
        <div>
          <h2 class="mb-2 text-sm font-semibold text-red-300">Database view failed</h2>
          <p class="mono max-w-xl text-xs text-fg-muted">{error}</p>
        </div>
      </div>
    {/if}
  </div>
</section>
