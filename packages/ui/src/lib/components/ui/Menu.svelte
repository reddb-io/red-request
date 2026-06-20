<script lang="ts">
  // Design-system dropdown menu (bits-ui DropdownMenu): accessible actions menu, themed.
  //   <Menu items={[{label, onSelect, destructive?}]}>
  //     {#snippet trigger(p)}<button {...p}>⋯</button>{/snippet}
  //   </Menu>
  import { DropdownMenu } from "bits-ui";
  import type { Snippet } from "svelte";

  type Item = { label: string; onSelect: () => void; destructive?: boolean };

  let {
    items,
    trigger,
  }: {
    items: Item[];
    trigger: Snippet<[Record<string, unknown>]>;
  } = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}{@render trigger(props)}{/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      sideOffset={4}
      align="end"
      class="panel z-50 min-w-40 p-1 shadow-xl outline-none"
    >
      {#each items as it (it.label)}
        <DropdownMenu.Item
          onSelect={it.onSelect}
          class="flex cursor-pointer items-center rounded px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-[var(--color-bg-2)] {it.destructive
            ? 'text-red-400'
            : 'text-fg-muted data-[highlighted]:text-fg'}"
        >
          {it.label}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
