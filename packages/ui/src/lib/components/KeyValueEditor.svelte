<script lang="ts">
  import type { Kv } from "@red-requester/core";

  let { items = $bindable(), placeholder = "name" }: {
    items: Kv[];
    placeholder?: string;
  } = $props();

  function add() {
    items.push({ name: "", value: "", enabled: true });
  }
  function removeAt(i: number) {
    items.splice(i, 1);
  }
</script>

<div class="flex flex-col gap-1">
  {#each items as item, i (i)}
    <div class="flex items-center gap-2">
      <input
        type="checkbox"
        bind:checked={item.enabled}
        class="accent-[var(--color-accent)]"
        aria-label="enabled"
      />
      <input
        bind:value={item.name}
        {placeholder}
        class="mono flex-1 rounded bg-[var(--color-bg-2)] px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
      />
      <input
        bind:value={item.value}
        placeholder="value"
        class="mono flex-1 rounded bg-[var(--color-bg-2)] px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
      />
      <button
        onclick={() => removeAt(i)}
        class="px-2 text-zinc-500 hover:text-[var(--color-accent)]"
        aria-label="remove">✕</button
      >
    </div>
  {/each}
  <button
    onclick={add}
    class="mt-1 self-start rounded px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
    >+ add</button
  >
</div>
