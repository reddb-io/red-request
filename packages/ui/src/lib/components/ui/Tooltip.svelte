<script lang="ts">
  // Design-system tooltip: bits-ui Tooltip merged onto the child element (no extra DOM),
  // themed with our tokens. Usage:
  //   <Tooltip text="New folder">{#snippet children(p)}<button {...p}>🗀</button>{/snippet}</Tooltip>
  // Needs a <Tooltip.Provider> ancestor (added once at the app root in +page.svelte).
  import { Tooltip } from "bits-ui";
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
  <Tooltip.Portal>
    <Tooltip.Content
      {side}
      sideOffset={6}
      class="z-[60] rounded-md border border-border bg-[var(--color-bg-0)] px-2 py-1 text-xs text-fg shadow-xl"
    >
      {text}
    </Tooltip.Content>
  </Tooltip.Portal>
</Tooltip.Root>
