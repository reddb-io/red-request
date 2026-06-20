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

  // folder collapse state + inline "new folder" input
  let collapsed = $state(new Set<string>());
  let addingFolderFor = $state<string | null>(null);
  let folderName = $state("");

  function toggle(key: string) {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    collapsed = new Set(collapsed);
  }

  function grouped(col: LoadedCollection) {
    const root = col.requests.filter((r) => !r.folder);
    const names = [
      ...new Set([
        ...col.collection.folders,
        ...col.requests.map((r) => r.folder).filter(Boolean),
      ]),
    ].sort((a, b) => a.localeCompare(b));
    return {
      root,
      folders: names.map((name) => ({
        name,
        requests: col.requests.filter((r) => r.folder === name),
      })),
    };
  }

  async function submitFolder(colId: string) {
    if (folderName.trim()) await ws.addFolder(folderName.trim());
    folderName = "";
    addingFolderFor = null;
  }
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

  {#snippet reqRow(col: LoadedCollection, req: LoadedCollection["requests"][number], indent: boolean)}
    <div class="group/req relative">
      <button
        onclick={() => ws.selectRequest(col.id, req.id)}
        class="flex w-full items-center gap-2 rounded py-1.5 pr-6 text-left text-sm hover:bg-[var(--color-bg-2)] {indent
          ? 'pl-6'
          : 'pl-2'}"
        class:bg-[var(--color-bg-2)]={ws.activeReq?.id === req.id && ws.activeColId === col.id}
      >
        <span class="mono w-11 shrink-0 text-[11px] font-bold {badge(req).color}"
          >{badge(req).label}</span
        >
        <span class="truncate text-zinc-300">{req.name}</span>
      </button>
      <button
        onclick={() => ws.deleteRequest(req.id)}
        title="Delete request"
        class="absolute top-1.5 right-1 text-zinc-600 opacity-0 group-hover/req:opacity-100 hover:text-red-400"
        >✕</button
      >
    </div>
  {/snippet}

  <div class="flex-1 overflow-y-auto px-2 pb-4">
    {#each ws.collections as col (col.id)}
      {@const g = grouped(col)}
      <div class="mt-2">
        <div class="flex items-center justify-between px-2 py-1">
          <span class="truncate text-xs font-semibold tracking-wide text-zinc-500 uppercase">
            {col.collection.name}
          </span>
          <span class="flex shrink-0 gap-1 text-zinc-500">
            <button onclick={() => ws.addRequest("")} title="New request" class="hover:text-zinc-200">＋</button>
            <button
              onclick={() => {
                addingFolderFor = addingFolderFor === col.id ? null : col.id;
                folderName = "";
              }}
              title="New folder"
              class="hover:text-zinc-200">🗀</button
            >
          </span>
        </div>

        {#if addingFolderFor === col.id}
          <input
            bind:value={folderName}
            placeholder="folder name"
            class="mono mb-1 ml-2 w-[calc(100%-1rem)] rounded bg-[var(--color-bg-2)] px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            onkeydown={(e) => {
              if (e.key === "Enter") submitFolder(col.id);
              if (e.key === "Escape") addingFolderFor = null;
            }}
          />
        {/if}

        {#each g.root as req (req.id)}
          {@render reqRow(col, req, false)}
        {/each}

        {#each g.folders as f (f.name)}
          {@const key = `${col.id}::${f.name}`}
          <div class="group/folder relative mt-0.5 flex items-center">
            <button
              onclick={() => toggle(key)}
              class="flex flex-1 items-center gap-1 rounded px-2 py-1 text-left text-xs text-zinc-300 hover:bg-[var(--color-bg-2)]"
            >
              <span class="text-zinc-500">{collapsed.has(key) ? "▸" : "▾"}</span>
              <span class="truncate">{f.name}</span>
              <span class="text-[10px] text-zinc-600">{f.requests.length}</span>
            </button>
            <span class="absolute right-1 flex gap-1 text-zinc-600 opacity-0 group-hover/folder:opacity-100">
              <button onclick={() => ws.addRequest(f.name)} title="New request here" class="hover:text-zinc-200">＋</button>
              <button onclick={() => ws.deleteFolder(f.name)} title="Delete folder (requests move to root)" class="hover:text-red-400">✕</button>
            </span>
          </div>
          {#if !collapsed.has(key)}
            {#each f.requests as req (req.id)}
              {@render reqRow(col, req, true)}
            {/each}
            {#if f.requests.length === 0}
              <div class="py-1 pl-6 text-[10px] text-zinc-600">empty</div>
            {/if}
          {/if}
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
