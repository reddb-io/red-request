<script lang="ts">
  // Wrapper over shadcn-svelte's Tooltip, merged onto the child element (no extra DOM).
  // Usage: <Tooltip text="New folder">{#snippet children(p)}<button {...p}>🗀</button>{/snippet}</Tooltip>
  // Needs a <Tooltip.Provider> ancestor (added once at the app root in +page.svelte).
  import * as Tooltip from "./tooltip/index.js";
  import type { Snippet } from "svelte";

  let {
    text,
    side = "top",
    children,
  }: {
    text: string;
    side?: "top" | "bottom" | "left" | "right";
    children: Snippet<[Record<string, unknown>]>;
  } = $props();
</script>

<Tooltip.Root>
  <Tooltip.Trigger>
    {#snippet child({ props })}
      {@render children(props)}
    {/snippet}
  </Tooltip.Trigger>
  <Tooltip.Content {side} sideOffset={6}>{text}</Tooltip.Content>
</Tooltip.Root>
