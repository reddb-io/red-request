<script lang="ts">
  // "Code" — generate a runnable snippet for the active request. ALL variables are resolved
  // (incl. decrypted secrets) so the snippet is actually runnable — e.g. Basic auth's base64
  // is computed from the real password, not from a literal `{{password}}` (which produced an
  // invalid credential). Same scope the real dispatch uses, so the snippet matches what's sent.
  import Modal from "./ui/Modal.svelte";
  import Select from "./ui/Select.svelte";
  import { Button } from "./ui/button/index.js";
  import { ws } from "../store.svelte";
  import {
    generateSnippet,
    SNIPPET_LANGS,
    type SnippetLang,
  } from "@reddb-io/request-core/codegen";
  import type { RequestDefinition } from "@reddb-io/request-core/request";
  import { resolveRequest } from "@reddb-io/request-core/resolver";

  // Two render modes:
//   • `embedded: true` — used as a tab in the Request panel. No modal
//     wrapper, no close button. Tab styling owns the chrome.
//   • `embedded: false` (default) — used as a modal. Wraps the body in
//     <Modal> + a close button.
  let { onClose, embedded = false }: {
    onClose?: () => void;
    embedded?: boolean;
  } = $props();

  let lang = $state<SnippetLang>("curl");
  let copied = $state(false);

  // Resolving secrets needs async decryption, so compute the snippet in an effect.
  let snippet = $state("");
  $effect(() => {
    const req = ws.activeReq;
    const l = lang;
    void ws.varInfo; // re-run when the active environment / vars change
    if (!req) {
      snippet = "";
      return;
    }
    const snap = $state.snapshot(req) as RequestDefinition;
    let cancelled = false;
    void ws.resolveScope().then((scope) => {
      if (!cancelled)
        snippet = generateSnippet(resolveRequest(snap, scope).request, l);
    });
    return () => {
      cancelled = true;
    };
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

{#snippet body()}
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
  </div>
  <pre
    class="mono flex-1 overflow-auto p-4 text-xs whitespace-pre text-fg">{snippet}</pre>
{/snippet}

{#if embedded}
  <div class="flex h-full flex-col overflow-hidden">
    {@render body()}
  </div>
{:else if onClose}
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
{/if}
