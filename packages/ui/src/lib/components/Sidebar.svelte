<script lang="ts">
  import { ws } from "../store.svelte";
  import { brand } from "../brand.generated";
  import { projectLabel } from "../project";
  import * as yamlio from "../yaml-io";
  import type { LoadedCollection } from "@red-request/core";

  let status = $state("");

  async function doExport() {
    try {
      const path = await yamlio.exportAll(
        $state.snapshot(ws.collections) as LoadedCollection[]
      );
      status = `Exported → ${path}`;
    } catch (e) {
      status = `Export failed: ${e instanceof Error ? e.message : e}`;
    }
  }
  async function doImport() {
    try {
      const n = await yamlio.importAll();
      await ws.reload();
      status = `Imported ${n} collection(s)`;
    } catch (e) {
      status = `Import failed: ${e instanceof Error ? e.message : e}`;
    }
  }

  const methodColor: Record<string, string> = {
    GET: "text-emerald-400",
    POST: "text-amber-400",
    PUT: "text-blue-400",
    PATCH: "text-purple-400",
    DELETE: "text-red-400",
    HEAD: "text-zinc-400",
    OPTIONS: "text-zinc-400",
  };
  const kindColor: Record<string, string> = {
    tcp: "text-cyan-400",
    udp: "text-teal-400",
    ping: "text-pink-400",
    whois: "text-orange-400",
    dns: "text-indigo-400",
  };
  const badge = (req: LoadedCollection["requests"][number]) =>
    req.kind === "http"
      ? { label: req.method, color: methodColor[req.method] ?? "text-zinc-400" }
      : { label: req.kind.toUpperCase(), color: kindColor[req.kind] ?? "text-zinc-400" };
</script>

<aside
  class="flex h-full w-64 shrink-0 flex-col border-r border-[var(--color-bg-3)] bg-[var(--color-bg-1)]"
>
  <div class="flex items-center gap-2 px-4 py-3">
    <span
      class="grid h-6 w-6 place-items-center rounded bg-[var(--color-accent)] text-sm font-bold text-black"
      >R</span
    >
    <div class="flex min-w-0 flex-col leading-tight">
      <span class="text-sm font-semibold">{brand.productName}</span>
      {#if ws.project}
        <button
          onclick={() => ws.backToSelector()}
          class="mono flex items-center gap-1 truncate text-[10px] text-zinc-500 hover:text-zinc-300"
          title="Switch project — {ws.project.db_path}"
        >
          {projectLabel(ws.project)}
          <span class="text-zinc-600">⇄</span>
        </button>
      {/if}
    </div>
  </div>

  <div class="flex gap-1 px-2 pb-2">
    {#each ["requests", "dashboard"] as const as v (v)}
      <button
        onclick={() => (ws.view = v)}
        class="flex-1 rounded px-2 py-1 text-xs capitalize"
        class:bg-[var(--color-bg-2)]={ws.view === v}
        class:text-[var(--color-accent)]={ws.view === v}
        class:text-zinc-400={ws.view !== v}>{v}</button
      >
    {/each}
  </div>

  <div class="flex-1 overflow-y-auto px-2 pb-4">
    {#each ws.collections as col (col.id)}
      <div class="mt-2">
        <div class="px-2 py-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
          {col.collection.name}
        </div>
        {#each col.requests as req (req.id)}
          <button
            onclick={() => ws.selectRequest(col.id, req.id)}
            class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--color-bg-2)]"
            class:bg-[var(--color-bg-2)]={ws.activeReq?.id === req.id &&
              ws.activeColId === col.id}
          >
            <span class="mono w-12 shrink-0 text-[11px] font-bold {badge(req).color}"
              >{badge(req).label}</span
            >
            <span class="truncate text-zinc-300">{req.name}</span>
          </button>
        {/each}
      </div>
    {/each}
  </div>

  <div class="border-t border-[var(--color-bg-3)] p-2">
    <div class="flex gap-1">
      <button
        onclick={doExport}
        class="flex-1 rounded border border-[var(--color-bg-3)] px-2 py-1 text-xs text-zinc-300 hover:bg-[var(--color-bg-2)]"
        title="Write a git-friendly YAML tree (no secret values)">Export YAML</button
      >
      <button
        onclick={doImport}
        class="flex-1 rounded border border-[var(--color-bg-3)] px-2 py-1 text-xs text-zinc-300 hover:bg-[var(--color-bg-2)]"
        title="Read the YAML tree back into the store">Import</button
      >
    </div>
    {#if status}
      <div class="mt-1 truncate text-[10px] text-zinc-500" title={status}>{status}</div>
    {/if}
  </div>
</aside>
