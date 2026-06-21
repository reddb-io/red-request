<script lang="ts">
  import type { Kv } from "@red-request/core";
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
</script>

<div class="flex flex-col gap-1">
  {#each items as item, i (i)}
    <div class="flex items-center gap-2">
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
