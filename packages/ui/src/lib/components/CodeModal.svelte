<script lang="ts">
  // "Code" — generate a runnable snippet for the active request. Non-secret vars are
  // resolved (so {{host}} → real value); secrets stay as {{NAME}} so nothing leaks.
  import Modal from "./ui/Modal.svelte";
  import Select from "./ui/Select.svelte";
  import { Button } from "./ui/button/index.js";
  import { ws } from "../store.svelte";
  import {
    generateSnippet,
    SNIPPET_LANGS,
    type SnippetLang,
  } from "@red-request/core/codegen";
  import type { RequestDefinition } from "@red-request/core/request";
  import { resolveRequest } from "@red-request/core/resolver";

  let { onClose }: { onClose: () => void } = $props();

  let lang = $state<SnippetLang>("curl");
  let copied = $state(false);

  const lookup = $derived(
    Object.fromEntries(
      Object.entries(ws.varInfo)
        .filter(([, info]) => !info.secret)
        .map(([k, info]) => [k, info.value])
    )
  );
  const snippet = $derived.by(() => {
    if (!ws.activeReq) return "";
    const snap = $state.snapshot(ws.activeReq) as RequestDefinition;
    return generateSnippet(resolveRequest(snap, lookup).request, lang);
  });

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }
</script>

<Modal {onClose} class="flex w-[680px] max-w-[92vw] flex-col rounded-xl">
  <div class="flex items-center gap-2 border-b border-border px-4 py-2">
    <h2 class="text-sm font-semibold text-fg">Code</h2>
    <Select
      bind:value={lang}
      items={SNIPPET_LANGS.map((l) => ({ value: l.id, label: l.label }))}
      ariaLabel="language"
      class="ml-2 w-auto"
    />
    <Button onclick={copy} variant="outline" size="xs" class="ml-auto"
      >{copied ? "Copied ✓" : "Copy"}</Button
    >
    <Button onclick={onClose} variant="ghost" size="icon-xs" aria-label="close">✕</Button>
  </div>
  <pre
    class="mono max-h-[60vh] overflow-auto p-4 text-xs whitespace-pre text-fg">{snippet}</pre>
</Modal>
