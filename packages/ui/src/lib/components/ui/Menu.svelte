<script lang="ts">
  // Design-system dropdown menu (bits-ui DropdownMenu): accessible actions menu, themed.
  // Items with `children` render as a submenu.
  //   <Menu items={[{label, onSelect}, {label, children:[…]}, {label, onSelect, destructive}]}>
  //     {#snippet trigger(p)}<button {...p}>⋯</button>{/snippet}
  //   </Menu>
  import { DropdownMenu } from "bits-ui";
  import type { Snippet } from "svelte";

  type Item = {
    label: string;
    onSelect?: () => void;
    destructive?: boolean;
    children?: Item[];
  };

  let {
    items,
    trigger,
  }: {
    items: Item[];
    trigger: Snippet<[Record<string, unknown>]>;
  } = $props();

  const itemCls = (d?: boolean) =>
    `flex cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-[var(--color-bg-2)] ${
      d ? "text-red-400" : "text-fg-muted data-[highlighted]:text-fg"
    }`;
  const menuCls = "panel z-50 min-w-40 p-1 shadow-xl outline-none";
</script>

{#snippet itemList(list: Item[])}
  {#each list as it (it.label)}
    {#if it.children}
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger class={itemCls()}>
          {it.label}<span class="text-fg-faint">▸</span>
        </DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent class={menuCls}>
          {@render itemList(it.children)}
        </DropdownMenu.SubContent>
      </DropdownMenu.Sub>
    {:else}
      <DropdownMenu.Item onSelect={it.onSelect} class={itemCls(it.destructive)}>
        {it.label}
      </DropdownMenu.Item>
    {/if}
  {/each}
{/snippet}

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}{@render trigger(props)}{/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content sideOffset={4} align="end" class={menuCls}>
      {@render itemList(items)}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
