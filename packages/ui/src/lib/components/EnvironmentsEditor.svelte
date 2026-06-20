<script lang="ts">
  import type { Kv, StoredEnvironment } from "@red-request/core";
  import { ws } from "../store.svelte";
  import KeyValueEditor from "./KeyValueEditor.svelte";

  let { onClose }: { onClose: () => void } = $props();

  function rowsOf(env: StoredEnvironment | null): Kv[] {
    return env
      ? Object.entries(env.vars).map(([name, value]) => ({
          name,
          value,
          enabled: true,
        }))
      : [];
  }

  const initial = ws.activeEnv ?? ws.environments[0] ?? null;
  let selected = $state<StoredEnvironment | null>(initial);
  // Local editing buffer for plain vars (Record <-> Kv[]).
  let varRows = $state<Kv[]>(rowsOf(initial));
  let renaming = $state(initial?.name ?? "");
  let newEnvName = $state("");
  let secretName = $state("");
  let secretValue = $state("");

  function loadVars(env: StoredEnvironment | null) {
    varRows = rowsOf(env);
    renaming = env?.name ?? "";
  }

  function select(env: StoredEnvironment) {
    selected = env;
    loadVars(env);
  }

  async function saveVars() {
    if (!selected) return;
    selected.vars = Object.fromEntries(
      varRows.filter((r) => r.enabled && r.name.trim()).map((r) => [r.name, r.value])
    );
    await ws.saveEnvVars(selected);
  }

  async function addEnv() {
    if (!newEnvName.trim()) return;
    await ws.createEnv(newEnvName.trim());
    newEnvName = "";
    selected = ws.activeEnv;
    loadVars(selected);
  }

  async function dupEnv() {
    if (!selected) return;
    await ws.duplicateEnv(selected);
    selected = ws.activeEnv;
    loadVars(selected);
  }

  async function delEnv() {
    if (!selected) return;
    await ws.deleteEnv(selected);
    selected = ws.environments[0] ?? null;
    loadVars(selected);
  }

  async function rename() {
    if (!selected || !renaming.trim() || renaming === selected.name) return;
    await ws.renameEnv(selected, renaming.trim());
  }

  async function addSecret() {
    if (!selected || !secretName.trim()) return;
    await ws.setSecret(selected, secretName.trim(), secretValue);
    secretName = "";
    secretValue = "";
  }
</script>

<div
  class="fixed inset-0 z-50 grid place-items-center bg-black/60"
  onclick={(e) => e.target === e.currentTarget && onClose()}
  role="presentation"
>
  <div
    class="flex h-[80vh] w-[860px] overflow-hidden rounded-xl border border-border bg-[var(--color-bg-1)] shadow-2xl"
  >
    <!-- env list -->
    <div class="flex w-56 shrink-0 flex-col border-r border-border">
      <div class="label px-3 py-2">
        Environments
      </div>
      <div class="flex-1 overflow-y-auto px-2">
        {#each ws.environments as env (env.name)}
          <button
            onclick={() => select(env)}
            class="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--color-bg-2)]"
            class:bg-[var(--color-bg-2)]={selected?.name === env.name}
          >
            <span class="truncate text-fg">{env.name}</span>
            <span class="text-[10px] text-fg-subtle"
              >{Object.keys(env.secrets).length}🔑</span
            >
          </button>
        {/each}
        {#if ws.environments.length === 0}
          <div class="px-2 py-2 text-xs text-fg-faint">No environments yet.</div>
        {/if}
      </div>
      <div class="flex gap-1 border-t border-border p-2">
        <input
          bind:value={newEnvName}
          placeholder="new env"
          class="input min-w-0 flex-1"
          onkeydown={(e) => e.key === "Enter" && addEnv()}
        />
        <button onclick={addEnv} class="btn btn-primary px-2">+</button>
      </div>
    </div>

    <!-- editor -->
    <div class="flex flex-1 flex-col overflow-hidden">
      <div class="flex items-center justify-between border-b border-border px-4 py-2">
        {#if selected}
          <input
            bind:value={renaming}
            onblur={rename}
            onkeydown={(e) => e.key === "Enter" && rename()}
            class="bg-transparent text-sm font-semibold text-fg-strong outline-none"
          />
          <div class="flex gap-2 text-sm">
            <button onclick={dupEnv} class="text-fg-muted hover:text-fg">Duplicate</button>
            <button onclick={delEnv} class="text-fg-muted hover:text-red-400">Delete</button>
          </div>
        {:else}
          <span class="text-sm text-fg-subtle">Select or create an environment</span>
        {/if}
        <button onclick={onClose} class="ml-3 text-fg-subtle hover:text-fg">✕</button>
      </div>

      {#if selected}
        <div class="flex-1 space-y-5 overflow-y-auto p-4">
          <section>
            <div class="mb-2 flex items-center justify-between">
              <h3 class="label">Variables</h3>
              <button
                onclick={saveVars}
                class="btn btn-ghost btn-sm"
                >Save vars</button
              >
            </div>
            <KeyValueEditor bind:items={varRows} placeholder="VAR_NAME" />
          </section>

          <section>
            <h3 class="label mb-2">
              Secrets <span class="ml-1 normal-case text-fg-faint">(encrypted in the .rdb; never exported)</span>
            </h3>
            <div class="flex flex-col gap-1">
              {#each Object.keys(selected.secrets) as name (name)}
                <div class="panel-2 flex items-center justify-between px-2 py-1 text-sm">
                  <span class="mono text-fg">{name}</span>
                  <span class="flex items-center gap-3">
                    <span class="text-[11px] text-emerald-500">•••• set</span>
                    <button
                      onclick={() => ws.removeSecret(selected!, name)}
                      class="text-fg-subtle hover:text-red-400">✕</button
                    >
                  </span>
                </div>
              {/each}
              {#if Object.keys(selected.secrets).length === 0}
                <div class="text-xs text-fg-faint">No secrets yet.</div>
              {/if}
            </div>
            <div class="mt-2 flex gap-1">
              <input bind:value={secretName} placeholder="NAME" class="input w-40" />
              <input
                bind:value={secretValue}
                type="password"
                placeholder="value"
                class="input flex-1"
                onkeydown={(e) => e.key === "Enter" && addSecret()}
              />
              <button onclick={addSecret} class="btn btn-primary">Set</button>
            </div>
          </section>
        </div>
      {:else}
        <div class="grid flex-1 place-items-center text-sm text-fg-faint">
          Create an environment to add variables and secrets.
        </div>
      {/if}
    </div>
  </div>
</div>
