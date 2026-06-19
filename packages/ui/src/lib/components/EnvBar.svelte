<script lang="ts">
  import { ws } from "../store.svelte";

  let showSecrets = $state(false);
  let newName = $state("");
  let newValue = $state("");

  const env = $derived(
    ws.environments.find((e) => e.name === ws.activeEnvName) ?? null
  );

  async function addSecret() {
    if (!newName.trim()) return;
    await ws.setSecret(newName.trim(), newValue);
    newName = "";
    newValue = "";
  }

  const field =
    "mono rounded bg-[var(--color-bg-2)] px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-[var(--color-accent)]";
</script>

<div class="relative flex items-center gap-2">
  <select bind:value={ws.activeEnvName} class={field}>
    {#if ws.environments.length === 0}
      <option value={null}>no env</option>
    {/if}
    {#each ws.environments as e (e.name)}
      <option value={e.name}>{e.name}</option>
    {/each}
  </select>
  <button
    onclick={() => (showSecrets = !showSecrets)}
    class="rounded px-2 py-1 text-sm text-zinc-400 hover:text-zinc-200"
    title="Manage secrets (stored in OS keychain)">🔑</button
  >

  {#if showSecrets}
    <div
      class="absolute top-9 right-0 z-10 w-80 rounded-lg border border-[var(--color-bg-3)] bg-[var(--color-bg-1)] p-3 shadow-xl"
    >
      <div class="mb-2 text-xs text-zinc-400">
        Secrets for <span class="text-zinc-200">{env?.name ?? "—"}</span> — values live in
        the OS keychain, never in the YAML.
      </div>
      {#if env}
        <div class="flex flex-col gap-1">
          {#each env.secretRefs as ref (ref)}
            <div class="flex items-center justify-between text-sm">
              <span class="mono text-zinc-200">{ref}</span>
              <button
                onclick={() => ws.removeSecret(ref)}
                class="text-zinc-500 hover:text-[var(--color-accent)]">✕</button
              >
            </div>
          {/each}
          {#if env.secretRefs.length === 0}
            <div class="text-xs text-zinc-600">none yet</div>
          {/if}
        </div>
        <div class="mt-3 flex flex-col gap-1">
          <input bind:value={newName} placeholder="NAME" class={field} />
          <input bind:value={newValue} placeholder="value" type="password" class={field} />
          <button
            onclick={addSecret}
            class="mt-1 rounded bg-[var(--color-accent)] px-2 py-1 text-sm font-medium text-black"
            >Save secret</button
          >
        </div>
      {:else}
        <div class="text-xs text-zinc-600">Select an environment first.</div>
      {/if}
    </div>
  {/if}
</div>
