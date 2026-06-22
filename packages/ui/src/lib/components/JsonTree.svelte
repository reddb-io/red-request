<script lang="ts">
  // Clickable JSON tree: clicking a value (or a container key) calls `onpick` with its
  // dotted/bracket path (e.g. data.items[0].id) — wire it to the response→variable extractor
  // for visual request chaining. Each node owns its own collapse; self-imports for recursion.
  import Self from "./JsonTree.svelte";

  interface Props {
    data: unknown;
    label?: string;
    path?: string;
    onpick: (path: string) => void;
    depth?: number;
  }
  let { data, label, path = "", onpick, depth = 0 }: Props = $props();

  // initial collapse depends only on this node's fixed depth (intentional one-time read)
  // svelte-ignore state_referenced_locally
  let open = $state(depth < 2);
  const isContainer = $derived(data !== null && typeof data === "object");
  const root = $derived(depth === 0);
  const entries = $derived.by(() => {
    if (Array.isArray(data))
      return data.map((v, i) => ({ label: String(i), val: v, p: `${path}[${i}]` }));
    if (data && typeof data === "object")
      return Object.entries(data as Record<string, unknown>).map(([k, v]) => ({
        label: k,
        val: v,
        p: path ? `${path}.${k}` : k,
      }));
    return [];
  });

  const fmt = (v: unknown) => (typeof v === "string" ? `"${v}"` : String(v));
  const summary = (v: unknown) =>
    Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v as object).length}}`;
</script>

{#if isContainer}
  {#if !root}
    <div class="flex items-center gap-1 py-px">
      <button class="w-3 text-fg-subtle hover:text-fg" onclick={() => (open = !open)} aria-label="toggle"
        >{open ? "▾" : "▸"}</button
      >
      <button
        class="mono text-fg hover:text-[var(--color-brand)]"
        title={`extract ${path}`}
        onclick={() => onpick(path)}>{label}</button
      >
      <span class="hint">{summary(data)}</span>
    </div>
  {/if}
  {#if open || root}
    <div class={root ? "" : "ml-1.5 border-l border-border pl-3"}>
      {#each entries as e (e.p)}
        <Self data={e.val} label={e.label} path={e.p} {onpick} depth={depth + 1} />
      {/each}
    </div>
  {/if}
{:else}
  <div class="flex items-baseline gap-1 py-px">
    <span class="inline-block w-3"></span>
    <span class="mono text-fg-muted">{label}:</span>
    <button
      class="mono rounded px-1 text-left text-fg hover:bg-[var(--color-brand)]/20 hover:text-[var(--color-brand)]"
      title={`extract ${path}`}
      onclick={() => onpick(path)}>{fmt(data)}</button
    >
  </div>
{/if}
