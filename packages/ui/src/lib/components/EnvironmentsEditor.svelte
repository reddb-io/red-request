<script lang="ts">
  import { onDestroy } from "svelte";
  import type { Kv, StoredEnvironment } from "@red-request/core";
  import { ws } from "../store.svelte";
  import KeyValueEditor from "./KeyValueEditor.svelte";
  import Modal from "./ui/Modal.svelte";
  import { Button } from "./ui/button/index.js";
  import { Input } from "./ui/input/index.js";

  // `inline` embeds the editor in a page (Settings) instead of a modal — no overlay,
  // no close button. `onClose` is only needed in modal mode.
  let { onClose, inline = false }: { onClose?: () => void; inline?: boolean } =
    $props();

  const rowsOf = (env: StoredEnvironment | null): Kv[] =>
    env ? rowsFromRecord(env.vars) : [];
  const rowsFromRecord = (rec: Record<string, string>): Kv[] =>
    Object.entries(rec).map(([name, value]) => ({ name, value, enabled: true }));
  const recordFromRows = (rows: Kv[]): Record<string, string> =>
    Object.fromEntries(
      rows.filter((r) => r.enabled && r.name.trim()).map((r) => [r.name.trim(), r.value])
    );

  // The pinned "Globals" entry is the reserved base environment (vars + secrets) that
  // every named environment layers on top of. Start on the active env, or on Globals.
  const initial = ws.activeEnv ?? ws.environments[0] ?? null;
  let onGlobals = $state(initial === null);
  let selected = $state<StoredEnvironment | null>(initial ?? ws.globals);
  let varRows = $state<Kv[]>(rowsOf(initial ?? ws.globals));
  let renaming = $state(initial?.name ?? "");
  let newEnvName = $state("");
  let secretName = $state("");
  let secretValue = $state("");

  function loadVars(env: StoredEnvironment | null) {
    varRows = rowsOf(env);
    renaming = env?.name ?? "";
  }

  function selectGlobals() {
    onGlobals = true;
    selected = ws.globals;
    loadVars(ws.globals);
  }

  function select(env: StoredEnvironment) {
    onGlobals = false;
    selected = env;
    loadVars(env);
  }

  // Autosave variables — no manual "save". Mirrors the request autosave: a debounced
  // effect persists the rows shortly after the last edit. Secrets already persist
  // immediately on Set/remove, so the whole editor is save-button-free.
  let varsTimer: ReturnType<typeof setTimeout> | null = null;
  let lastVarsKey = "";
  let lastVarsSnap = "";
  function scheduleVarsSave() {
    if (varsTimer) clearTimeout(varsTimer);
    varsTimer = setTimeout(() => {
      varsTimer = null;
      if (!selected) return;
      selected.vars = recordFromRows(varRows);
      void ws.saveEnvVars(selected);
    }, 500);
  }
  /** Flush a pending vars autosave now (on close/unmount) so a fast edit isn't lost. */
  function flushVarsSave() {
    if (!varsTimer) return;
    clearTimeout(varsTimer);
    varsTimer = null;
    if (!selected) return;
    selected.vars = recordFromRows(varRows);
    void ws.saveEnvVars(selected);
  }
  $effect(() => {
    const env = selected;
    const snap = JSON.stringify(varRows); // deep-tracks every row/field
    const key = onGlobals ? "Globals" : (env?.name ?? "");
    if (!env) {
      lastVarsKey = "";
      lastVarsSnap = "";
      return;
    }
    if (key !== lastVarsKey) {
      // env switch — re-baseline, never save
      lastVarsKey = key;
      lastVarsSnap = snap;
      return;
    }
    if (snap === lastVarsSnap) return;
    lastVarsSnap = snap;
    scheduleVarsSave();
  });

  async function addEnv() {
    if (!newEnvName.trim()) return;
    await ws.createEnv(newEnvName.trim());
    newEnvName = "";
    onGlobals = false;
    selected = ws.activeEnv;
    loadVars(selected);
  }

  async function dupEnv() {
    if (!selected) return;
    await ws.duplicateEnv(selected);
    onGlobals = false;
    selected = ws.activeEnv;
    loadVars(selected);
  }

  async function delEnv() {
    if (!selected) return;
    await ws.deleteEnv(selected);
    const next = ws.environments[0] ?? null;
    if (next) select(next);
    else selectGlobals();
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

  // Persist any pending variable edit when the editor goes away (modal close / nav).
  onDestroy(flushVarsSave);
</script>

{#snippet body()}
    <!-- env list -->
    <div class="flex w-56 shrink-0 flex-col border-r border-border">
      <div class="label px-3 py-2">
        Environments
      </div>
      <div class="flex-1 overflow-y-auto px-2">
        <button
          onclick={selectGlobals}
          class="row justify-between px-2"
          class:is-active={onGlobals}
        >
          <span class="truncate text-fg">Global</span>
          <span class="text-xs text-fg-faint">base</span>
        </button>
        <div class="my-1 border-t border-border"></div>
        {#each ws.environments as env (env.name)}
          <button
            onclick={() => select(env)}
            class="row justify-between px-2"
            class:is-active={!onGlobals && selected?.name === env.name}
          >
            <span class="truncate text-fg">{env.name}</span>
            <span class="text-xs text-fg-subtle"
              >{Object.keys(env.secrets).length}🔑</span
            >
          </button>
        {/each}
        {#if ws.environments.length === 0}
          <div class="px-2 py-2 text-xs text-fg-faint">No environments yet.</div>
        {/if}
      </div>
      <div class="flex gap-1 border-t border-border p-2">
        <Input
          bind:value={newEnvName}
          placeholder="new env"
          class="h-7 min-w-0 flex-1"
          onkeydown={(e) => e.key === "Enter" && addEnv()}
        />
        <Button onclick={addEnv} size="icon-xs" aria-label="add environment">+</Button>
      </div>
    </div>

    <!-- editor -->
    <div class="flex flex-1 flex-col overflow-hidden">
      <div class="flex items-center justify-between border-b border-border px-4 py-2">
        {#if onGlobals}
          <span class="flex items-baseline gap-2">
            <span class="text-sm font-semibold text-fg-strong">Global</span>
            <span class="hint">base variables — apply to every environment</span>
          </span>
        {:else if selected}
          <input
            bind:value={renaming}
            onblur={rename}
            onkeydown={(e) => e.key === "Enter" && rename()}
            class="bg-transparent text-sm font-semibold text-fg-strong outline-none"
          />
          <div class="flex gap-2 text-sm">
            <Button onclick={dupEnv} variant="outline" size="xs">Duplicate</Button>
            <Button onclick={delEnv} variant="outline" size="xs" class="hover:text-red-400">Delete</Button>
          </div>
        {:else}
          <span class="text-sm text-fg-subtle">Select or create an environment</span>
        {/if}
        {#if onClose}
          <Button onclick={onClose} variant="ghost" size="icon-xs" class="ml-3">✕</Button>
        {/if}
      </div>

      {#if onGlobals || selected}
        <div class="flex-1 space-y-5 overflow-y-auto p-4">
          <section>
            <div class="mb-2 flex items-center justify-between">
              <h3 class="label">Variables</h3>
              <span class="hint">saved automatically</span>
            </div>
            <KeyValueEditor bind:items={varRows} placeholder="VAR_NAME" />
          </section>

          {#if selected}
          <section>
            <h3 class="label mb-2">
              Secrets <span class="ml-1 normal-case text-fg-faint">(encrypted in the .rdb; never exported)</span>
            </h3>
            <div class="flex flex-col gap-1">
              {#each Object.keys(selected.secrets) as name (name)}
                <div class="panel-2 flex items-center justify-between px-2 py-1 text-sm">
                  <span class="mono text-fg">{name}</span>
                  <span class="flex items-center gap-3">
                    <span class="text-xs text-emerald-500">•••• set</span>
                    <Button
                      onclick={() => ws.removeSecret(selected!, name)}
                      variant="ghost"
                      size="icon-xs"
                      class="hover:text-red-400">✕</Button
                    >
                  </span>
                </div>
              {/each}
              {#if Object.keys(selected.secrets).length === 0}
                <div class="text-xs text-fg-faint">No secrets yet.</div>
              {/if}
            </div>
            <div class="mt-2 flex gap-1">
              <Input bind:value={secretName} placeholder="NAME" class="h-7 w-40" />
              <Input
                bind:value={secretValue}
                type="password"
                placeholder="value"
                class="h-7 flex-1"
                onkeydown={(e) => e.key === "Enter" && addSecret()}
              />
              <Button onclick={addSecret} size="xs">Set</Button>
            </div>
          </section>
          {/if}
        </div>
      {:else}
        <div class="grid flex-1 place-items-center text-sm text-fg-faint">
          Create an environment to add variables and secrets.
        </div>
      {/if}
    </div>
{/snippet}

{#if inline}
  <div class="panel flex h-[68vh] overflow-hidden">
    {@render body()}
  </div>
{:else}
  <Modal {onClose} class="flex h-[80vh] w-[860px] rounded-xl">
    {@render body()}
  </Modal>
{/if}
