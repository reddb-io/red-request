<script lang="ts">
  // Collapsible XML tree mirroring JsonTree: each element owns its own collapse, self-imports
  // for recursion. Built from a DOM Element (parsed via DOMParser in ResponsePanel). Element
  // children only — mixed text between elements is summarised, leaf text is shown inline.
  import Self from "./XmlTree.svelte";

  interface Props {
    node: Element;
    depth?: number;
  }
  let { node, depth = 0 }: Props = $props();

  // initial collapse depends only on this node's fixed depth (intentional one-time read)
  // svelte-ignore state_referenced_locally
  let open = $state(depth < 3);
  const children = $derived(Array.from(node.children));
  const attrs = $derived(
    Array.from(node.attributes).map((a) => ({ name: a.name, value: a.value }))
  );
  const hasChildren = $derived(children.length > 0);
  // leaf text only matters when there are no element children
  const text = $derived(hasChildren ? "" : (node.textContent ?? "").trim());
</script>

{#snippet openTag(showAttrs: boolean)}<span class="text-fg-faint">&lt;</span><span
    class="text-[var(--color-brand)]">{node.tagName}</span
  >{#if showAttrs}{#each attrs as a (a.name)}<span class="text-fg-muted"> {a.name}</span
      ><span class="text-fg-faint">=</span><span class="text-emerald-400">"{a.value}"</span
      >{/each}{/if}<span class="text-fg-faint">&gt;</span>{/snippet}

{#if hasChildren}
  <div class="py-px">
    <div class="flex items-center gap-1">
      <button
        class="w-3 text-fg-subtle hover:text-fg"
        onclick={() => (open = !open)}
        aria-label="toggle">{open ? "▾" : "▸"}</button
      >
      <span class="mono">{@render openTag(true)}</span>
      {#if !open}
        <span class="hint">… &lt;/{node.tagName}&gt;</span>
      {/if}
    </div>
    {#if open}
      <div class="ml-1.5 border-l border-border pl-3">
        {#each children as c, i (i)}
          <Self node={c} depth={depth + 1} />
        {/each}
      </div>
      <div class="mono text-fg-faint">&lt;/{node.tagName}&gt;</div>
    {/if}
  </div>
{:else}
  <div class="flex items-baseline gap-1 py-px">
    <span class="inline-block w-3"></span>
    <span class="mono">{@render openTag(true)}{#if text}<span class="text-fg">{text}</span
        >{/if}<span class="text-fg-faint">&lt;/{node.tagName}&gt;</span></span
    >
  </div>
{/if}
