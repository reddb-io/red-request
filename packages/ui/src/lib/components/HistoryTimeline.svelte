<script lang="ts">
  // Git-style version timeline for the active request, powered by reddb's native VCS.
  // Left: a vertical version graph (newest at top, scroll down to the first version).
  // Right: the request at the selected version, a line diff vs the previous version, and
  // a one-click rollback. The graph renders a single lane today (the app commits linearly
  // on `main`); it's laid out to extend to multiple lanes once branching lands.
  import Modal from "./ui/Modal.svelte";
  import { Button } from "./ui/button/index.js";
  import { ws } from "../store.svelte";
  import * as repo from "../repo";
  import type { RequestHistoryNode } from "../repo";
  import type { RequestDefinition } from "@reddb-io/request-core/request";

  let {
    onClose,
    embedded = false,
  }: { onClose?: () => void; embedded?: boolean } = $props();

  let loading = $state(true);
  let nodes = $state<RequestHistoryNode[]>([]);
  let selected = $state<RequestHistoryNode | null>(null);
  let restoring = $state(false);

  // Version boundaries (commits where this request actually changed), newest first.
  const versions = $derived(nodes.filter((n) => n.changedHere && n.value));

  function relTime(ms: number): string {
    if (!ms) return "";
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }
  const shortHash = (h: string) => h.slice(0, 7);

  $effect(() => {
    const colId = ws.activeColId;
    const reqId = ws.activeReq?.id ?? null;
    void load(colId, reqId);
  });
  async function load(colId: string | null | undefined, reqId: string | null) {
    loading = true;
    nodes = [];
    selected = null;
    if (!colId || !reqId) {
      loading = false;
      return;
    }
    const nextNodes = await repo.requestHistory(colId, reqId, 100);
    if (colId !== ws.activeColId || reqId !== (ws.activeReq?.id ?? null)) {
      return;
    }
    nodes = nextNodes;
    selected = nextNodes.find((n) => n.changedHere && n.value) ?? null;
    loading = false;
  }

  /** The previous version (older edit) before `node`, for the diff. */
  function prevVersion(node: RequestHistoryNode): RequestHistoryNode | null {
    const i = versions.findIndex((v) => v.commit.hash === node.commit.hash);
    return i >= 0 && i + 1 < versions.length ? versions[i + 1]! : null;
  }
  const isLatestVersion = $derived(
    !!selected && versions[0]?.commit.hash === selected.commit.hash
  );

  type DiffLine = { kind: "ctx" | "add" | "del"; text: string };
  /** Minimal LCS line diff of two pretty-printed JSON blobs (git-style +/- view). */
  function lineDiff(oldText: string, newText: string): DiffLine[] {
    const a = oldText.split("\n");
    const b = newText.split("\n");
    const n = a.length;
    const m = b.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () =>
      new Array(m + 1).fill(0)
    );
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i]![j] =
          a[i] === b[j]
            ? lcs[i + 1]![j + 1]! + 1
            : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    const out: DiffLine[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        out.push({ kind: "ctx", text: a[i]! });
        i++;
        j++;
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
        out.push({ kind: "del", text: a[i]! });
        i++;
      } else {
        out.push({ kind: "add", text: b[j]! });
        j++;
      }
    }
    while (i < n) out.push({ kind: "del", text: a[i++]! });
    while (j < m) out.push({ kind: "add", text: b[j++]! });
    return out;
  }

  const diff = $derived.by<DiffLine[] | null>(() => {
    if (!selected?.value) return null;
    const prev = prevVersion(selected);
    if (!prev?.value) return null; // first version — nothing to diff against
    return lineDiff(
      JSON.stringify(prev.value, null, 2),
      JSON.stringify(selected.value, null, 2)
    );
  });

  async function restore() {
    if (!selected?.value) return;
    restoring = true;
    try {
      await ws.restoreRequestVersion(
        structuredClone($state.snapshot(selected.value)) as RequestDefinition
      );
      onClose?.();
    } finally {
      restoring = false;
    }
  }
</script>

{#snippet timeline(showClose: boolean)}
  <div class="flex items-center gap-2 border-b border-border px-4 py-2">
    <h2 class="text-sm font-semibold text-fg">Version history</h2>
    <span class="text-xs text-muted-fg">{ws.activeReq?.name ?? ""}</span>
    {#if !loading}
      <span class="text-[11px] text-fg-faint"
        >· {versions.length} version{versions.length === 1 ? "" : "s"}</span
      >
    {/if}
    {#if showClose && onClose}
      <Button
        onclick={onClose}
        variant="ghost"
        size="icon-xs"
        class="ml-auto"
        aria-label="close">✕</Button
      >
    {/if}
  </div>

  {#if loading}
    <div class="flex flex-1 items-center justify-center text-xs text-muted-fg">
      Loading history…
    </div>
  {:else if versions.length === 0}
    <div
      class="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-fg"
    >
      No saved versions yet. Edits you make from now on appear here as a timeline.
    </div>
  {:else}
    <div class="flex flex-1 overflow-hidden">
      <!-- graph timeline -->
      <ul class="w-[320px] shrink-0 overflow-auto py-2">
        {#each versions as n, i (n.commit.hash)}
          {@const isSel = selected?.commit.hash === n.commit.hash}
          <li class="relative">
            <!-- graph gutter: vertical spine + node -->
            <div class="pointer-events-none absolute top-0 bottom-0 left-[18px] w-px bg-border"
              class:opacity-0={i === 0 && false}></div>
            <button
              class="relative flex w-full items-start gap-3 py-1.5 pr-3 pl-2 text-left hover:bg-muted/60 disabled:cursor-default {isSel
                ? 'bg-muted'
                : ''}"
              onclick={() => (selected = n)}
            >
              <span class="relative z-10 mt-1 flex h-[14px] w-[14px] shrink-0 items-center justify-center">
                <span
                  class="h-3 w-3 rounded-full border-2 {isSel
                    ? 'border-accent bg-accent'
                    : 'border-accent bg-bg'}"
                ></span>
              </span>
              <span class="min-w-0 flex-1">
                <span
                  class="block truncate text-xs font-medium text-fg"
                >
                  {i === 0 ? "Current" : n.commit.message || "edit"}
                </span>
                <span class="block text-[11px] text-muted-fg">
                  {relTime(n.commit.timestampMs)} · <span class="mono">{shortHash(n.commit.hash)}</span>
                </span>
              </span>
            </button>
          </li>
        {/each}
      </ul>

      <!-- detail: request at the selected version + diff + rollback -->
      <div class="flex flex-1 flex-col overflow-hidden border-l border-border">
        {#if selected?.value}
          <div class="flex items-center gap-2 border-b border-border px-4 py-2">
            <span
              class="mono rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-fg"
              >{selected.value.method ?? selected.value.kind ?? "REQ"}</span
            >
            <span class="truncate text-sm font-medium text-fg">{selected.value.name}</span>
            <Button
              onclick={restore}
              size="sm"
              class="ml-auto shrink-0"
              disabled={restoring || isLatestVersion}
            >
              {restoring
                ? "Restoring…"
                : isLatestVersion
                  ? "Current version"
                  : "Restore this version"}
            </Button>
          </div>
          <div class="mono truncate px-4 py-2 text-xs text-muted-fg" title={selected.value.url ?? ""}>
            {selected.value.url ?? ""}
          </div>
          <div class="flex-1 overflow-auto px-4 pb-4">
            {#if diff}
              <div class="mb-1 text-[11px] text-fg-faint">Changes from the previous version</div>
              <pre class="mono overflow-auto rounded bg-muted/30 p-3 text-[11px] leading-snug">{#each diff as l}<span
                    class="block {l.kind === 'add'
                      ? 'bg-green-500/15 text-green-300'
                      : l.kind === 'del'
                        ? 'bg-red-500/15 text-red-300'
                        : 'text-fg-muted'}">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} {l.text}</span
                  >{/each}</pre>
            {:else}
              <div class="mb-1 text-[11px] text-fg-faint">First version (no earlier version to diff)</div>
              <pre
                class="mono overflow-auto rounded bg-muted/30 p-3 text-[11px] whitespace-pre-wrap text-fg">{JSON.stringify(
                  selected.value,
                  null,
                  2
                )}</pre>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}
{/snippet}

{#if embedded}
  <div class="flex h-full min-h-[460px] flex-col">
    {@render timeline(false)}
  </div>
{:else if onClose}
  <Modal {onClose} class="flex h-[640px] w-[920px] max-w-[95vw] flex-col rounded-xl">
    {@render timeline(true)}
  </Modal>
{/if}
