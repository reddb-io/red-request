<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./ui/Modal.svelte";
  import { Input } from "./ui/input/index.js";
  import { Button } from "./ui/button/index.js";
  import { ws } from "../store.svelte";
  import type { GqlSchema } from "@red-request/core";

  let { onClose }: { onClose: () => void } = $props();

  let schema = $state<GqlSchema | null>(null);
  let error = $state("");
  let loading = $state(true);
  let query = $state("");
  let open = $state<Record<string, boolean>>({});

  onMount(load);
  async function load() {
    loading = true;
    error = "";
    try {
      schema = await ws.introspectGraphQL();
      // open the root types by default
      for (const t of [schema.queryType, schema.mutationType]) if (t) open[t] = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  const rootOf = (name: string) =>
    name === schema?.queryType ? "Query" : name === schema?.mutationType ? "Mutation" : "";

  const filtered = $derived.by(() => {
    if (!schema) return [];
    const q = query.trim().toLowerCase();
    const order = (n: string) => (n === schema!.queryType ? 0 : n === schema!.mutationType ? 1 : 2);
    return [...schema.types]
      .filter(
        (t) =>
          !q ||
          t.name.toLowerCase().includes(q) ||
          t.fields.some((f) => f.name.toLowerCase().includes(q))
      )
      .sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name));
  });
</script>

<Modal {onClose} class="flex h-[80vh] w-[680px] max-w-[94vw] flex-col rounded-xl">
  <div class="flex items-center gap-2 border-b border-border px-4 py-2">
    <h2 class="text-sm font-semibold text-fg">GraphQL schema</h2>
    {#if schema}<span class="hint">{schema.types.length} types</span>{/if}
    <Button onclick={load} variant="ghost" size="icon-xs" class="ml-auto" aria-label="refresh"
      >⟳</Button
    >
    <Button onclick={onClose} variant="ghost" size="icon-xs" aria-label="close">✕</Button>
  </div>

  {#if loading}
    <div class="grid flex-1 place-items-center text-sm text-fg-subtle">Introspecting…</div>
  {:else if error}
    <div class="flex-1 p-4">
      <div class="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
        {error}
      </div>
      <p class="hint mt-2">
        Set the request URL to your GraphQL endpoint, then retry. Some servers disable
        introspection in production.
      </p>
    </div>
  {:else if schema}
    <div class="border-b border-border p-2">
      <Input bind:value={query} placeholder="Search types & fields…" class="h-7" />
    </div>
    <div class="flex-1 overflow-y-auto p-2">
      {#each filtered as t (t.name)}
        <div class="mb-1">
          <button
            onclick={() => (open[t.name] = !open[t.name])}
            class="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-[var(--color-bg-2)]"
          >
            <span class="text-fg-subtle">{open[t.name] ? "▾" : "▸"}</span>
            <span class="mono font-semibold text-fg-strong">{t.name}</span>
            {#if rootOf(t.name)}
              <span class="badge bg-[var(--color-brand)]/15 text-[var(--color-brand)]"
                >{rootOf(t.name)}</span
              >
            {:else}
              <span class="hint">{t.kind.toLowerCase()}</span>
            {/if}
            <span class="hint ml-auto">{t.fields.length} fields</span>
          </button>
          {#if open[t.name]}
            <div class="ml-5 border-l border-border pl-3">
              {#each t.fields as f (f.name)}
                <div class="flex items-baseline gap-2 py-0.5 text-xs">
                  <span class="mono text-fg">{f.name}{f.args.length ? "(…)" : ""}</span>
                  <span class="mono text-[var(--color-brand)]">{f.type}</span>
                  {#if f.desc}<span class="truncate text-fg-faint">— {f.desc}</span>{/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</Modal>
