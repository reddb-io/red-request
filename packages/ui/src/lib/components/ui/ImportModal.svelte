<script lang="ts">
  import Modal from "./Modal.svelte";
  import { ws } from "../../store.svelte";
  import { Button } from "./button/index.js";
  import { Input } from "./input/index.js";
  import { Textarea } from "./textarea/index.js";

  let { onClose }: { onClose: () => void } = $props();

  type Mode = "paste" | "url" | "file";
  let mode = $state<Mode>("paste");
  let text = $state("");
  let url = $state("");
  let busy = $state(false);
  let error = $state("");

  const MODES: { id: Mode; label: string }[] = [
    { id: "paste", label: "Paste" },
    { id: "url", label: "URL" },
    { id: "file", label: "File" },
  ];

  async function run(action: () => Promise<unknown>) {
    busy = true;
    error = "";
    try {
      await action();
      onClose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const doImport = () => run(() => ws.importText(text));
  const doImportUrl = () => run(() => ws.importFromUrl(url));
  const doImportFile = () =>
    run(async () => {
      const result = await ws.importFile();
      if (result === null) throw new Error("no file selected");
    });
</script>

<Modal {onClose} class="flex w-[600px] max-w-[92vw] flex-col rounded-xl">
  <div class="flex items-center justify-between border-b border-border px-4 py-2">
    <h2 class="text-sm font-semibold text-fg">Import</h2>
    <Button onclick={onClose} variant="ghost" size="icon-xs" aria-label="close">✕</Button>
  </div>
  <div class="p-3">
    <div class="mb-3 flex gap-1 rounded-lg bg-muted p-0.5" role="tablist">
      {#each MODES as m (m.id)}
        <button
          type="button"
          role="tab"
          aria-selected={mode === m.id}
          class="flex-1 rounded-md px-3 py-1 text-xs transition-colors {mode === m.id
            ? 'bg-bg font-medium text-fg shadow-sm'
            : 'text-fg/60 hover:text-fg'}"
          onclick={() => {
            mode = m.id;
            error = "";
          }}>{m.label}</button
        >
      {/each}
    </div>

    {#if mode === "paste"}
      <!-- svelte-ignore a11y_autofocus -->
      <Textarea
        bind:value={text}
        rows={9}
        autofocus
        placeholder={"Paste a cURL command, OpenAPI/Swagger (JSON or YAML), a Postman collection, a HAR file… or a URL to a spec."}
        class="mono text-xs"
      />
    {:else if mode === "url"}
      <!-- svelte-ignore a11y_autofocus -->
      <Input
        bind:value={url}
        autofocus
        placeholder="https://api.example.com/openapi.json"
        class="mono text-xs"
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === "Enter" && url.trim() && !busy) doImportUrl();
        }}
      />
      <p class="hint mt-2">
        Fetched through the engine (no CORS limits) — JSON and YAML specs both work.
      </p>
    {:else}
      <div
        class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-8"
      >
        <span class="hint">Pick an OpenAPI / Postman / Insomnia / HAR file (.json, .yaml, .yml)</span>
        <Button onclick={doImportFile} disabled={busy} size="xs" variant="outline"
          >Choose file…</Button
        >
      </div>
    {/if}

    {#if error}<div class="mt-2 text-xs text-red-400">{error}</div>{/if}
    <div class="mt-3 flex items-center justify-between">
      <span class="hint"
        >cURL → a request · OpenAPI · Postman · HAR → a whole collection (auto-detected).
        Servers become environments.</span
      >
      <div class="flex gap-2">
        <Button onclick={onClose} variant="outline" size="xs">Cancel</Button>
        {#if mode === "paste"}
          <Button onclick={doImport} disabled={busy || !text.trim()} size="xs">Import</Button>
        {:else if mode === "url"}
          <Button onclick={doImportUrl} disabled={busy || !url.trim()} size="xs">
            {busy ? "Fetching…" : "Import"}
          </Button>
        {/if}
      </div>
    </div>
  </div>
</Modal>
