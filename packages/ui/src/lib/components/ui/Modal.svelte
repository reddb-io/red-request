<script lang="ts">
  // Design-system modal: bits-ui Dialog (focus-trap, Escape, scroll-lock, outside-click)
  // with our themed overlay + panel. Render content via the default snippet.
  import { Dialog } from "bits-ui";
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
  function onOpenChange(v: boolean) {
    if (!v) onClose?.();
  }
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-black/60" />
    <Dialog.Content
      class="panel fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 overflow-hidden shadow-2xl outline-none {cls}"
    >
      {@render children()}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
