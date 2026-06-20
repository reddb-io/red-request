<script lang="ts">
  import { ws } from "../store.svelte";
  import EnvironmentsEditor from "./EnvironmentsEditor.svelte";

  let showEditor = $state(false);
</script>

<div class="flex items-center gap-2">
  <select bind:value={ws.activeEnvName} class="select w-auto">
    {#if ws.environments.length === 0}
      <option value={null}>no env</option>
    {/if}
    {#each ws.environments as e (e.name)}
      <option value={e.name}>{e.name}</option>
    {/each}
  </select>
  <button
    onclick={() => (showEditor = true)}
    class="btn btn-ghost"
    title="Manage environments, variables & secrets">Environments</button
  >
</div>

{#if showEditor}
  <EnvironmentsEditor onClose={() => (showEditor = false)} />
{/if}
