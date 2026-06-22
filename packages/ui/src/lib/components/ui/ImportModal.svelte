<script lang="ts">
  import Modal from "./Modal.svelte";
  import { ws } from "../../store.svelte";
  import { Button } from "./button/index.js";
  import { Textarea } from "./textarea/index.js";

  let { onClose }: { onClose: () => void } = $props();

  let text = $state("");
  let busy = $state(false);
  let error = $state("");

  async function doImport() {
    if (!text.trim()) return;
    busy = true;
    error = "";
    try {
      await ws.importText(text);
      onClose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<Modal {onClose} class="flex w-[600px] max-w-[92vw] flex-col rounded-xl">
  <div class="flex items-center justify-between border-b border-border px-4 py-2">
    <h2 class="text-sm font-semibold text-fg">Import</h2>
    <Button onclick={onClose} variant="ghost" size="icon-xs" aria-label="close">✕</Button>
  </div>
  <div class="p-3">
    <!-- svelte-ignore a11y_autofocus -->
    <Textarea
      bind:value={text}
      rows={9}
      autofocus
      placeholder={"Paste a cURL command, OpenAPI/Swagger, a Postman collection, or a HAR file…"}
      class="mono text-xs"
    />
    {#if error}<div class="mt-2 text-xs text-red-400">{error}</div>{/if}
    <div class="mt-3 flex items-center justify-between">
      <span class="hint"
        >cURL → a request · OpenAPI · Postman · HAR → a whole collection (auto-detected).</span
      >
      <div class="flex gap-2">
        <Button onclick={onClose} variant="outline" size="xs">Cancel</Button>
        <Button
          onclick={doImport}
          disabled={busy || !text.trim()}
          size="xs">Import</Button
        >
      </div>
    </div>
  </div>
</Modal>
