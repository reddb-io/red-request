<script lang="ts">
  // Modal over shadcn-svelte's Dialog (focus-trap, Escape, scroll-lock, outside-click,
  // overlay + portal). Render content via the default snippet; call sites size it via `class`.
  import * as Dialog from "./dialog/index.js";
  import { cn } from "$lib/utils.js";
  import type { Snippet } from "svelte";

  let {
    onClose,
    class: cls = "",
    children,
  }: {
    onClose?: () => void;
    class?: string;
    children: Snippet;
  } = $props();

  let open = $state(true);
</script>

<Dialog.Root
  bind:open
  onOpenChange={(v) => {
    if (!v) onClose?.();
  }}
>
  <Dialog.Content
    showCloseButton={false}
    class={cn("flex max-w-none gap-0 overflow-hidden p-0", cls)}
  >
    {@render children()}
  </Dialog.Content>
</Dialog.Root>
