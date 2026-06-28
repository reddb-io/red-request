<script lang="ts">
  import type { Kv } from "@reddb-io/request-core";
  import { ws } from "../store.svelte";
  import VarField from "./VarField.svelte";
  import { Button } from "./ui/button/index.js";

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

  // drag-to-reorder rows (grab the ⠿ handle)
  let dragIndex = $state<number | null>(null);
  let overIndex = $state<number | null>(null);
  function drop() {
    if (dragIndex !== null && overIndex !== null && dragIndex !== overIndex) {
      const [moved] = items.splice(dragIndex, 1);
      items.splice(overIndex, 0, moved!);
    }
    dragIndex = null;
    overIndex = null;
  }
</script>

<div class="flex flex-col gap-1">
  {#each items as item, i (i)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="flex items-center gap-2 rounded {item.fromProfile
        ? 'bg-[var(--color-brand)]/8 ring-1 ring-[var(--color-brand)]/40'
        : ''} {dragIndex === i
        ? 'opacity-40'
        : ''} {overIndex === i && dragIndex !== i
        ? 'ring-1 ring-[var(--color-brand)]'
        : ''}"
      ondragover={(e) => {
        if (dragIndex === null) return;
        e.preventDefault();
        overIndex = i;
      }}
      ondrop={(e) => {
        e.preventDefault();
        drop();
      }}
    >
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <span
        role="button"
        tabindex="-1"
        aria-label="drag to reorder"
        draggable="true"
        ondragstart={() => (dragIndex = i)}
        ondragend={() => {
          dragIndex = null;
          overIndex = null;
        }}
        class="mono cursor-grab px-0.5 text-fg-faint select-none hover:text-fg-muted active:cursor-grabbing"
        >⠿</span
      >
      <input
        type="checkbox"
        bind:checked={item.enabled}
        class="accent-[var(--color-brand)]"
        aria-label="enabled"
      />
      <div class="flex-1">
        <VarField bind:value={item.name} known={ws.knownVars} values={ws.varTitles} dense {placeholder} />
      </div>
      <div class="flex-1">
        <VarField bind:value={item.value} known={ws.knownVars} values={ws.varTitles} dense placeholder="value" />
      </div>
      {#if item.fromProfile}
        <span
          class="rounded bg-[var(--color-brand)]/15 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[var(--color-brand)] uppercase"
          title="Injected by the bound profile. Edit the value to override (badge clears)."
          aria-label="from profile"
        >
          profile
        </span>
      {/if}
      <Button
        onclick={() => removeAt(i)}
        variant="ghost"
        size="icon-xs"
        aria-label="remove">✕</Button
      >
    </div>
  {/each}
  <Button
    onclick={add}
    variant="ghost"
    size="xs"
    class="mt-1 self-start"
    >+ add</Button
  >
</div>
