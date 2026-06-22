<script lang="ts">
  // Home view: the project's at-a-glance surface. A header, then the dashboard
  // (catalog + history/latency), then the shared network pool (proxies +
  // profiles). This is the single scroll host — its children are plain blocks.
  import Dashboard from "./Dashboard.svelte";
  import { ws } from "../store.svelte";
  import { projectLabel } from "../project";
</script>

<section class="flex h-full flex-col gap-6 overflow-auto bg-[var(--color-bg-0)] p-5">
  <div class="flex items-baseline gap-3">
    <h1 class="text-base font-semibold text-fg">Home</h1>
    {#if ws.project}
      <span class="mono text-xs text-fg-faint">{projectLabel(ws.project)}</span>
    {/if}
  </div>

  <Dashboard />
</section>
