<script lang="ts">
  // Wrapper over shadcn-svelte's DropdownMenu: accessible, pre-styled actions menu.
  // Items with `children` render as a submenu.
  //   <Menu items={[{label, onSelect}, {label, children:[…]}, {label, onSelect, destructive}]}>
  //     {#snippet trigger(p)}<button {...p}>⋯</button>{/snippet}
  //   </Menu>
  import * as DropdownMenu from "./dropdown-menu/index.js";
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
</script>

{#snippet itemList(list: Item[])}
  {#each list as it (it.label)}
    {#if it.children}
      <DropdownMenu.Sub>
        <DropdownMenu.SubTrigger>{it.label}</DropdownMenu.SubTrigger>
        <DropdownMenu.SubContent>
          {@render itemList(it.children)}
        </DropdownMenu.SubContent>
      </DropdownMenu.Sub>
    {:else}
      <DropdownMenu.Item
        onSelect={it.onSelect}
        variant={it.destructive ? "destructive" : "default"}
      >
        {it.label}
      </DropdownMenu.Item>
    {/if}
  {/each}
{/snippet}

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}{@render trigger(props)}{/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="min-w-40">
    {@render itemList(items)}
  </DropdownMenu.Content>
</DropdownMenu.Root>
