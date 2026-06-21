<script lang="ts">
  import { ws } from "../store.svelte";
  import EnvironmentsEditor from "./EnvironmentsEditor.svelte";
  import Select from "./ui/Select.svelte";
  import { Button } from "./ui/button/index.js";

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
  <Button
    onclick={() => (showEditor = true)}
    variant="outline"
    size="xs"
    title="Manage environments, variables & secrets">Environments</Button
  >
</div>

{#if showEditor}
  <EnvironmentsEditor onClose={() => (showEditor = false)} />
{/if}
