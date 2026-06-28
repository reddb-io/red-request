<script lang="ts">
  import { onDestroy } from "svelte";
  import Copy from "@lucide/svelte/icons/copy";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import X from "@lucide/svelte/icons/x";
  import type { Kv, StoredEnvironment } from "@reddb-io/request-core";
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
  const secretNeedsValue = (env: StoredEnvironment, name: string): boolean =>
    (env.secrets[name] as { missing?: boolean } | undefined)?.missing === true;

  // The pinned "Globals" entry is the reserved base environment (vars + secrets) that
  // every named environment layers on top of. Start on the active env, or on Globals.
  const initial = ws.activeEnv ?? ws.environments[0] ?? null;
  let onGlobals = $state(initial === null);
  let selected = $state<StoredEnvironment | null>(initial ?? ws.globals);
  let varRows = $state<Kv[]>(rowsOf(initial ?? ws.globals));
  let renaming = $state(initial?.name ?? "");
  let secretName = $state("");
  let secretValue = $state("");
  let draggingEnv = $state<string | null>(null);
  let envDropBefore = $state<string | null | undefined>(undefined);

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

  function nextEnvName(): string {
    const taken = new Set(ws.environments.map((env) => env.name));
    let name = "env";
    let i = 2;
    while (taken.has(name)) name = `env-${i++}`;
    return name;
  }

  async function addEnv() {
    await ws.createEnv(nextEnvName());
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

  function envDragOver(e: DragEvent, env: StoredEnvironment, index: number) {
    if (!draggingEnv) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    envDropBefore =
      e.clientX - rect.left < rect.width / 2
        ? env.name
        : (ws.environments[index + 1]?.name ?? null);
  }

  async function envDrop() {
    if (draggingEnv && envDropBefore !== undefined)
      await ws.reorderEnvironment(draggingEnv, envDropBefore);
    draggingEnv = null;
    envDropBefore = undefined;
  }

  // Persist any pending variable edit when the editor goes away (modal close / nav).
  onDestroy(flushVarsSave);
</script>

{#snippet body()}
    <div class="flex flex-1 flex-col overflow-hidden">
      <div class="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3">
        <button
          type="button"
          onclick={selectGlobals}
          class="h-8 shrink-0 rounded-t border border-border px-3 text-xs font-medium {onGlobals
            ? 'bg-[var(--color-bg-2)] text-fg'
            : 'bg-transparent text-fg-subtle hover:text-fg'}"
        >
          Global
        </button>
        {#each ws.environments as env, i (env.name)}
          <button
            type="button"
            draggable="true"
            onclick={() => select(env)}
            ondragstart={(e) => {
              draggingEnv = env.name;
              e.dataTransfer?.setData("text/plain", env.name);
              if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
            }}
            ondragover={(e) => envDragOver(e, env, i)}
            ondrop={(e) => {
              e.preventDefault();
              void envDrop();
            }}
            ondragend={() => {
              draggingEnv = null;
              envDropBefore = undefined;
            }}
            class="relative h-8 max-w-44 shrink-0 rounded-t border border-border px-3 text-xs font-medium {selected?.name === env.name && !onGlobals
              ? 'bg-[var(--color-bg-2)] text-fg'
              : 'bg-transparent text-fg-subtle hover:text-fg'}"
          >
            {#if envDropBefore === env.name}
              <span class="absolute top-1 bottom-1 -left-1 w-0.5 rounded bg-[var(--color-brand)]"></span>
            {/if}
            <span class="truncate">{env.name}</span>
            {#if Object.keys(env.secrets).length > 0}
              <span class="ml-2 text-[10px] text-fg-faint">{Object.keys(env.secrets).length}</span>
            {/if}
          </button>
        {/each}
        <button
          type="button"
          aria-label="add environment"
          title="Add environment"
          ondragover={(e) => {
            if (!draggingEnv) return;
            e.preventDefault();
            envDropBefore = null;
          }}
          ondrop={(e) => {
            e.preventDefault();
            void envDrop();
          }}
          onclick={addEnv}
          class="relative flex h-8 w-9 shrink-0 items-center justify-center rounded-t border border-border text-fg-subtle hover:bg-[var(--color-bg-2)] hover:text-fg"
        >
          {#if envDropBefore === null}
            <span class="absolute top-1 bottom-1 -left-1 w-0.5 rounded bg-[var(--color-brand)]"></span>
          {/if}
          <Plus size={14} />
        </button>
      </div>
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
            <Button onclick={dupEnv} variant="outline" size="xs">
              <Copy size={13} /> Duplicate
            </Button>
            <Button onclick={delEnv} variant="outline" size="xs" class="hover:text-red-400">
              <Trash2 size={13} /> Delete
            </Button>
          </div>
        {:else}
          <span class="text-sm text-fg-subtle">Select or create an environment</span>
        {/if}
        {#if onClose}
          <Button onclick={onClose} variant="ghost" size="icon-xs" class="ml-3" aria-label="close environments">
            <X size={14} />
          </Button>
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
                    <span
                      class="text-xs"
                      class:text-amber-400={secretNeedsValue(selected, name)}
                      class:text-emerald-500={!secretNeedsValue(selected, name)}
                    >
                      {secretNeedsValue(selected, name) ? "needs value" : "•••• set"}
                    </span>
                    <Button
                      onclick={() => ws.removeSecret(selected!, name)}
                      variant="ghost"
                      size="icon-xs"
                      class="hover:text-red-400"
                      aria-label={`remove ${name} secret`}
                    >
                      <X size={13} />
                    </Button>
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
