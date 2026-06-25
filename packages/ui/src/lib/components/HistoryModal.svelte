<script lang="ts">
  // "History" — native VCS time-travel for the active request. Lists the distinct
  // versions of this request across the store's commits (reddb AS OF), and restores
  // any of them. Each commit is a whole-store restore point; we resolve THIS request
  // at each commit and collapse runs of identical values into one version entry.
  import Modal from "./ui/Modal.svelte";
  import { Button } from "./ui/button/index.js";
  import { ws } from "../store.svelte";
  import * as repo from "../repo";
  import type { RequestDefinition } from "@red-request/core/request";

  let { onClose }: { onClose: () => void } = $props();

  interface Version {
    hash: string;
    message: string;
    ts: number;
    req: RequestDefinition;
  }

  let loading = $state(true);
  let versions = $state<Version[]>([]);
  let selected = $state<Version | null>(null);
  let restoring = $state(false);

  const colId = ws.activeColId;
  const reqId = ws.activeReq?.id ?? null;

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

  $effect(() => {
    // run once on mount
    void load();
  });

  async function load() {
    if (!colId || !reqId) {
      loading = false;
      return;
    }
    const commits = await repo.listCommits(40);
    const out: Version[] = [];
    let prevJson: string | null = null;
    // commits are newest-first; keep an entry whenever this request's value differs
    // from the newer kept one — that collapses unrelated commits into distinct versions.
    for (const c of commits) {
      const req = await repo.requestAsOf(colId, reqId, c.hash);
      if (!req) continue; // didn't exist at this commit yet
      const json = JSON.stringify(req);
      if (json === prevJson) continue;
      prevJson = json;
      out.push({ hash: c.hash, message: c.message, ts: c.timestampMs, req });
    }
    versions = out;
    selected = out[0] ?? null;
    loading = false;
  }

  async function restore() {
    if (!selected) return;
    restoring = true;
    try {
      await ws.restoreRequestVersion(
        structuredClone($state.snapshot(selected.req)) as RequestDefinition
      );
      onClose();
    } finally {
      restoring = false;
    }
  }
</script>

<Modal {onClose} class="flex h-[560px] w-[760px] max-w-[94vw] flex-col rounded-xl">
  <div class="flex items-center gap-2 border-b border-border px-4 py-2">
    <h2 class="text-sm font-semibold text-fg">History</h2>
    <span class="text-xs text-muted-fg">{ws.activeReq?.name ?? ""}</span>
    <Button
      onclick={onClose}
      variant="ghost"
      size="icon-xs"
      class="ml-auto"
      aria-label="close">✕</Button
    >
  </div>

  {#if loading}
    <div class="flex flex-1 items-center justify-center text-xs text-muted-fg">
      Loading history…
    </div>
  {:else if versions.length === 0}
    <div
      class="flex flex-1 items-center justify-center px-6 text-center text-xs text-muted-fg"
    >
      No saved versions yet. Edits you make from now on become restore points.
    </div>
  {:else}
    <div class="flex flex-1 overflow-hidden">
      <!-- version list -->
      <ul class="w-64 shrink-0 overflow-auto border-r border-border py-1">
        {#each versions as v, i (v.hash)}
          <li>
            <button
              class="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-xs hover:bg-muted {selected?.hash ===
              v.hash
                ? 'bg-muted'
                : ''}"
              onclick={() => (selected = v)}
            >
              <span class="font-medium text-fg">
                {i === 0 ? "Current" : v.message || "edit"}
              </span>
              <span class="text-[11px] text-muted-fg">{relTime(v.ts)}</span>
            </button>
          </li>
        {/each}
      </ul>

      <!-- preview -->
      <div class="flex flex-1 flex-col overflow-auto p-4">
        {#if selected}
          <div class="mb-3 flex items-center gap-2">
            <span
              class="mono rounded bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-fg"
              >{selected.req.method ?? selected.req.kind ?? "REQ"}</span
            >
            <span class="text-sm font-medium text-fg">{selected.req.name}</span>
          </div>
          <div class="mono mb-3 break-all text-xs text-muted-fg">
            {selected.req.url ?? ""}
          </div>
          <pre
            class="mono flex-1 overflow-auto rounded bg-muted/40 p-3 text-[11px] whitespace-pre-wrap text-fg">{JSON.stringify(
              selected.req,
              null,
              2
            )}</pre>
          <div class="mt-3 flex justify-end">
            <Button
              onclick={restore}
              size="sm"
              disabled={restoring || versions[0]?.hash === selected.hash}
            >
              {restoring
                ? "Restoring…"
                : versions[0]?.hash === selected.hash
                  ? "Current version"
                  : "Restore this version"}
            </Button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</Modal>
