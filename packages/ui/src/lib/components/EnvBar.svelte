<script lang="ts">
  import { ws } from "../store.svelte";
  import EnvironmentsEditor from "./EnvironmentsEditor.svelte";

  let showEditor = $state(false);

  const field =
    "mono rounded bg-[var(--color-bg-2)] px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-[var(--color-accent)]";
</script>

<div class="flex items-center gap-2">
  <select bind:value={ws.activeEnvName} class={field}>
    {#if ws.environments.length === 0}
      <option value={null}>no env</option>
    {/if}
    {#each ws.environments as e (e.name)}
      <option value={e.name}>{e.name}</option>
    {/each}
  </select>
  <button
    onclick={() => (showEditor = true)}
    class="rounded border border-[var(--color-bg-3)] px-2 py-1 text-sm text-zinc-300 hover:bg-[var(--color-bg-2)]"
    title="Manage environments, variables & secrets">Environments</button
  >
</div>

{#if showEditor}
  <EnvironmentsEditor onClose={() => (showEditor = false)} />
{/if}
