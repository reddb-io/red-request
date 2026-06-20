<script lang="ts">
  import { ws } from "../store.svelte";
  import EnvironmentsEditor from "./EnvironmentsEditor.svelte";
  import Select from "./ui/Select.svelte";

  let showEditor = $state(false);
</script>

<div class="flex items-center gap-2">
  <Select
    value={ws.activeEnvName ?? ""}
    items={ws.environments.map((e) => e.name)}
    placeholder="no env"
    onChange={(v) => (ws.activeEnvName = v)}
    ariaLabel="environment"
    class="w-auto"
  />
  <button
    onclick={() => (showEditor = true)}
    class="btn btn-ghost"
    title="Manage environments, variables & secrets">Environments</button
  >
</div>

{#if showEditor}
  <EnvironmentsEditor onClose={() => (showEditor = false)} />
{/if}
