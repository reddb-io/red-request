<script lang="ts">
  import Modal from "./Modal.svelte";
  import { Button } from "./button/index.js";

  let {
    title,
    description,
    confirmLabel,
    busyLabel = "Working...",
    cancelLabel = "Cancel",
    destructive = false,
    onCancel,
    onConfirm,
  }: {
    title: string;
    description: string;
    confirmLabel: string;
    busyLabel?: string;
    cancelLabel?: string;
    destructive?: boolean;
    onCancel: () => void;
    onConfirm: () => Promise<void> | void;
  } = $props();

  let busy = $state(false);
  let error = $state("");

  async function confirmAction() {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await onConfirm();
      onCancel();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      busy = false;
    }
  }
</script>

<Modal
  onClose={() => {
    if (!busy) onCancel();
  }}
  class="flex w-[420px] max-w-[92vw] flex-col rounded-lg border border-border bg-[var(--color-bg-0)]"
>
  <div class="border-b border-border px-4 py-3">
    <h2 class="text-sm font-semibold text-fg-strong">{title}</h2>
  </div>
  <div class="px-4 py-3">
    <p class="text-sm leading-6 text-fg-muted">{description}</p>
    {#if error}
      <p class="mono mt-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
        {error}
      </p>
    {/if}
  </div>
  <div class="flex justify-end gap-2 border-t border-border px-4 py-3">
    <Button onclick={onCancel} disabled={busy} variant="ghost" size="xs">
      {cancelLabel}
    </Button>
    <Button
      onclick={confirmAction}
      disabled={busy}
      aria-busy={busy}
      variant={destructive ? "destructive" : "default"}
      size="xs"
    >
      {busy ? busyLabel : confirmLabel}
    </Button>
  </div>
</Modal>
