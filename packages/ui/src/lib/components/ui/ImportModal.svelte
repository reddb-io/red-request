<script lang="ts">
  import Modal from "./Modal.svelte";
  import { ws } from "../../store.svelte";

  let { onClose }: { onClose: () => void } = $props();

  let text = $state("");
  let busy = $state(false);

  async function doImport() {
    if (!text.trim()) return;
    busy = true;
    try {
      await ws.importCurl(text);
      onClose();
    } finally {
      busy = false;
    }
  }
</script>

<Modal {onClose} class="flex w-[600px] max-w-[92vw] flex-col rounded-xl">
  <div class="flex items-center justify-between border-b border-border px-4 py-2">
    <h2 class="text-sm font-semibold text-fg">Import from cURL</h2>
    <button onclick={onClose} class="btn-icon" aria-label="close">✕</button>
  </div>
  <div class="p-3">
    <!-- svelte-ignore a11y_autofocus -->
    <textarea
      bind:value={text}
      rows="9"
      autofocus
      placeholder={"Paste a curl command (browser → Copy as cURL)…"}
      class="textarea mono text-xs"
    ></textarea>
    <div class="mt-3 flex items-center justify-between">
      <span class="hint">Parses method, URL, headers, body and basic auth.</span>
      <div class="flex gap-2">
        <button onclick={onClose} class="btn btn-ghost">Cancel</button>
        <button
          onclick={doImport}
          disabled={busy || !text.trim()}
          class="btn btn-primary">Import</button
        >
      </div>
    </div>
  </div>
</Modal>
