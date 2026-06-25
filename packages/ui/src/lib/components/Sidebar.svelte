<script lang="ts">
  import { ws } from "../store.svelte";
  import Tooltip from "./ui/Tooltip.svelte";
  import Menu from "./ui/Menu.svelte";
  import ImportModal from "./ui/ImportModal.svelte";
  import { Button } from "./ui/button/index.js";
  import { Input } from "./ui/input/index.js";
  import { Badge } from "./ui/badge/index.js";

  let showImport = $state(false);
  import { projectLabel } from "../project";
  import type { LoadedCollection } from "@red-request/core";

  const methodColor: Record<string, string> = {
    GET: "text-emerald-400",
    POST: "text-amber-400",
    PUT: "text-blue-400",
    PATCH: "text-purple-400",
    DELETE: "text-red-400",
    HEAD: "text-fg-muted",
    OPTIONS: "text-fg-muted",
  };
  const kindColor: Record<string, string> = {
    ws: "text-violet-400",
    sse: "text-fuchsia-400",
    grpc: "text-lime-400",
    tcp: "text-cyan-400",
    udp: "text-teal-400",
    ping: "text-pink-400",
    whois: "text-orange-400",
    dns: "text-indigo-400",
  };
  const badge = (req: LoadedCollection["requests"][number]) =>
    req.kind === "http"
      ? { label: req.method, color: methodColor[req.method] ?? "text-fg-muted" }
      : { label: req.kind.toUpperCase(), color: kindColor[req.kind] ?? "text-fg-muted" };

  // folder collapse state + inline "new folder" input
  let collapsed = $state(new Set<string>());
  let addingFolderFor = $state<string | null>(null);
  let folderName = $state("");

  // inline request rename
  let renamingId = $state<string | null>(null);
  let renameValue = $state("");
  let renameEl = $state<HTMLInputElement | null>(null);
  // Focus + select the whole name as soon as the rename input mounts (entering rename mode
  // or creating a new request), so the user can type a name immediately. autofocus only
  // focuses; .select() highlights the text so typing replaces it.
  $effect(() => {
    void renamingId;
    renameEl?.focus();
    renameEl?.select();
  });
  function startRename(req: LoadedCollection["requests"][number]) {
    renamingId = req.id;
    renameValue = req.name;
  }
  async function commitRename() {
    if (renamingId) await ws.renameRequest(renamingId, renameValue);
    renamingId = null;
  }
  // Create a request and drop straight into rename mode (with the name selected). `colId`
  // targets the collection whose "+" was clicked, not whichever is currently active.
  async function addAndRename(folder: string, colId: string) {
    const id = await ws.addRequest(folder, colId);
    if (id) {
      renameValue = "New Request";
      renamingId = id;
    }
  }

  // inline collection rename
  let renamingColId = $state<string | null>(null);
  let colRenameValue = $state("");
  function startRenameCol(col: LoadedCollection) {
    renamingColId = col.id;
    colRenameValue = col.collection.name;
  }
  async function commitRenameCol() {
    if (renamingColId) await ws.renameCollection(renamingColId, colRenameValue);
    renamingColId = null;
  }

  // drag-and-drop: reorder requests and move them across folders AND collections.
  // `dropTarget` is the live insertion point — the target collection, the folder, and the
  // sibling id to land *before* (null → end of that folder). `dropFolderHeader`/
  // `dropRootHeader` light up a header when you hover it to drop "into" that container.
  let draggingId = $state<string | null>(null);
  let dropTarget = $state<{
    colId: string;
    folder: string;
    beforeId: string | null;
  } | null>(null);
  let dropFolderHeader = $state<string | null>(null);
  let dropRootHeader = $state<string | null>(null);

  function resetDrag() {
    draggingId = null;
    dropTarget = null;
    dropFolderHeader = null;
    dropRootHeader = null;
  }

  // Top half of a row → insert before it; bottom half → insert after (before `nextId`,
  // or end of folder when `nextId` is null).
  function onRowDragOver(
    e: DragEvent,
    colId: string,
    folder: string,
    reqId: string,
    nextId: string | null
  ) {
    if (!draggingId) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientY - rect.top < rect.height / 2;
    dropFolderHeader = null;
    dropRootHeader = null;
    dropTarget = { colId, folder, beforeId: before ? reqId : nextId };
  }

  function commitDrop() {
    if (draggingId && dropTarget) {
      void ws.reorderRequest(
        draggingId,
        dropTarget.folder,
        dropTarget.beforeId,
        dropTarget.colId
      );
    }
    resetDrag();
  }

  const lineBefore = (colId: string, folder: string, reqId: string) =>
    !!dropTarget &&
    dropTarget.colId === colId &&
    dropTarget.folder === folder &&
    dropTarget.beforeId === reqId;
  const lineEnd = (colId: string, folder: string) =>
    !!dropTarget &&
    dropTarget.colId === colId &&
    dropTarget.folder === folder &&
    dropTarget.beforeId === null;

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
    if (folderName.trim()) await ws.addFolder(folderName.trim(), colId);
    folderName = "";
    addingFolderFor = null;
  }

  // Create an empty collection and drop straight into its inline name field.
  async function newCollection() {
    const id = await ws.addCollection();
    renamingColId = id;
    colRenameValue = "New Collection";
  }
</script>

<aside
  class="flex h-full w-full flex-col bg-[var(--color-bg-1)]"
>
  <div class="flex items-center gap-2 px-4 py-3">
    <div class="flex min-w-0 flex-1 flex-col leading-tight">
      {#if ws.project}
        <span class="truncate text-sm font-semibold text-fg-strong" title={ws.project.db_path}
          >{projectLabel(ws.project)}</span
        >
      {/if}
      <span class="text-[10px] font-medium tracking-wide text-fg-faint uppercase">Collections</span>
    </div>
    <Tooltip text="New collection" side="bottom">
      {#snippet children(p)}
        <Button {...p} onclick={newCollection} variant="outline" size="xs">+ Collection</Button>
      {/snippet}
    </Tooltip>
  </div>

  {#snippet reqRow(
    col: LoadedCollection,
    req: LoadedCollection["requests"][number],
    indent: boolean,
    folder: string,
    nextId: string | null,
    isLast: boolean,
  )}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="group/req relative"
      class:opacity-40={draggingId === req.id}
      ondragover={(e) => onRowDragOver(e, col.id, folder, req.id, nextId)}
      ondrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        commitDrop();
      }}
    >
      {#if lineBefore(col.id, folder, req.id)}
        <div class="drop-line" style="top: -1px"></div>
      {/if}
      {#if isLast && lineEnd(col.id, folder)}
        <div class="drop-line" style="bottom: -1px"></div>
      {/if}
      <button
        onclick={() => ws.selectRequest(col.id, req.id)}
        draggable={renamingId !== req.id}
        ondragstart={(e) => {
          draggingId = req.id;
          e.dataTransfer?.setData("text/plain", req.id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        }}
        ondragend={resetDrag}
        class="row pr-6 {indent ? 'pl-6' : 'pl-2'}"
        class:is-active={ws.activeReq?.id === req.id && ws.activeColId === col.id}
      >
        <Badge
          variant="secondary"
          class="mono w-11 shrink-0 justify-center px-1 py-0 text-[10px] {badge(req).color}"
          >{badge(req).label}</Badge
        >
        {#if renamingId === req.id}
          <!-- svelte-ignore a11y_autofocus -->
          <Input
            bind:ref={renameEl}
            bind:value={renameValue}
            autofocus
            onclick={(e) => e.stopPropagation()}
            onblur={commitRename}
            onkeydown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") renamingId = null;
            }}
            class="h-6 flex-1"
          />
        {:else}
          <span class="truncate text-fg">{req.name}</span>
        {/if}
      </button>
      <Menu
        items={[
          { label: "Duplicate", onSelect: () => ws.duplicateRequest(req.id) },
          { label: "Rename", onSelect: () => startRename(req) },
          {
            label: "Move to",
            children: [
              { label: "(root)", onSelect: () => ws.moveRequest(req.id, "") },
              ...col.collection.folders.map((f) => ({
                label: f,
                onSelect: () => ws.moveRequest(req.id, f),
              })),
            ],
          },
          {
            label: "Delete",
            onSelect: () => ws.deleteRequest(req.id),
            destructive: true,
          },
        ]}
      >
        {#snippet trigger(p)}
          <Button
            {...p}
            variant="ghost"
            size="icon-xs"
            aria-label="request actions"
            class="absolute top-1.5 right-1 opacity-0 group-hover/req:opacity-100 data-[state=open]:opacity-100"
            >⋯</Button
          >
        {/snippet}
      </Menu>
    </div>
  {/snippet}

  <div class="flex-1 overflow-y-auto px-2 pb-4">
    {#each ws.collections as col (col.id)}
      {@const g = grouped(col)}
      <div class="mt-2">
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="group/col flex items-center justify-between rounded px-2 py-1"
          class:ring-1={dropRootHeader === col.id}
          class:ring-[var(--color-brand)]={dropRootHeader === col.id}
          ondragover={(e) => {
            if (!draggingId) return;
            e.preventDefault();
            dropFolderHeader = null;
            dropRootHeader = col.id;
            dropTarget = { colId: col.id, folder: "", beforeId: null };
          }}
          ondragleave={() => (dropRootHeader = null)}
          ondrop={(e) => {
            e.preventDefault();
            commitDrop();
          }}
        >
          {#if renamingColId === col.id}
            <!-- svelte-ignore a11y_autofocus -->
            <Input
              bind:value={colRenameValue}
              autofocus
              onblur={commitRenameCol}
              onkeydown={(e) => {
                if (e.key === "Enter") commitRenameCol();
                if (e.key === "Escape") renamingColId = null;
              }}
              class="h-6"
            />
          {:else}
            <button
              onclick={() => toggle(col.id)}
              class="flex min-w-0 flex-1 items-center gap-1 text-left"
              title="Collapse / expand collection"
            >
              <span class="shrink-0 text-fg-subtle">{collapsed.has(col.id) ? "▸" : "▾"}</span>
              <span class="label truncate">{col.collection.name}</span>
              {#if col.collection.defaultProfileId}
                {@const dp = ws.profiles.find((p) => p.id === col.collection.defaultProfileId)}
                {#if dp}
                  <Tooltip text="Default profile: {dp.name || 'profile'}" side="bottom">
                    {#snippet children(p)}
                      <span
                        {...p}
                        class="mono ml-1 shrink-0 rounded bg-[var(--color-bg-2)] px-1 text-[10px] text-fg-muted"
                        >🪪</span
                      >
                    {/snippet}
                  </Tooltip>
                {/if}
              {/if}
            </button>
          {/if}
          <span class="flex shrink-0 items-center gap-1 text-fg-subtle">
            <Tooltip text="New request">
              {#snippet children(p)}
                <Button {...p} onclick={() => addAndRename("", col.id)} variant="ghost" size="icon-xs">＋</Button>
              {/snippet}
            </Tooltip>
            <Tooltip text="New folder">
              {#snippet children(p)}
                <Button
                  {...p}
                  onclick={() => {
                    addingFolderFor = addingFolderFor === col.id ? null : col.id;
                    folderName = "";
                  }}
                  variant="ghost"
                  size="icon-xs">🗀</Button
                >
              {/snippet}
            </Tooltip>
            <Menu
              items={[
                { label: "Rename", onSelect: () => startRenameCol(col) },
                { label: "Import…", onSelect: () => (showImport = true) },
                {
                  label: col.collection.cookieJar ? "Cookie jar: on" : "Cookie jar: off",
                  onSelect: () => ws.toggleCookieJar(col.id),
                },
                ...(col.collection.cookieJar
                  ? [{ label: "Clear cookies", onSelect: () => ws.clearCookies(col.id) }]
                  : []),
                {
                  label: "Delete collection",
                  onSelect: () => ws.deleteCollection(col.id),
                  destructive: true,
                },
              ]}
            >
              {#snippet trigger(p)}
                <Button {...p} aria-label="collection actions" variant="ghost" size="icon-xs"
                  >⋯</Button
                >
              {/snippet}
            </Menu>
          </span>
        </div>

        {#if !collapsed.has(col.id)}
        {#if addingFolderFor === col.id}
          <Input
            bind:value={folderName}
            placeholder="folder name"
            class="mono mb-1 ml-2 h-7 w-[calc(100%-1rem)]"
            onkeydown={(e) => {
              if (e.key === "Enter") submitFolder(col.id);
              if (e.key === "Escape") addingFolderFor = null;
            }}
          />
        {/if}

        {#each g.root as req, i (req.id)}
          {@render reqRow(col, req, false, "", g.root[i + 1]?.id ?? null, i === g.root.length - 1)}
        {/each}

        {#each g.folders as f (f.name)}
          {@const key = `${col.id}::${f.name}`}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="group/folder relative mt-0.5 flex items-center rounded"
            class:ring-1={dropFolderHeader === key}
            class:ring-[var(--color-brand)]={dropFolderHeader === key}
            ondragover={(e) => {
              if (!draggingId) return;
              e.preventDefault();
              e.stopPropagation();
              dropRootHeader = null;
              dropFolderHeader = key;
              dropTarget = { colId: col.id, folder: f.name, beforeId: null };
            }}
            ondragleave={() => (dropFolderHeader = null)}
            ondrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              commitDrop();
            }}
          >
            <button
              onclick={() => toggle(key)}
              class="row flex-1 gap-1 px-2 py-1 text-xs"
            >
              <span class="text-fg-subtle">{collapsed.has(key) ? "▸" : "▾"}</span>
              <span class="truncate">{f.name}</span>
              <span class="text-xs text-fg-faint">{f.requests.length}</span>
            </button>
            <span class="absolute right-1 flex gap-1 text-fg-faint opacity-0 group-hover/folder:opacity-100">
              <Tooltip text="New request here">
                {#snippet children(p)}
                  <Button {...p} onclick={() => addAndRename(f.name, col.id)} variant="ghost" size="icon-xs">＋</Button>
                {/snippet}
              </Tooltip>
              <Tooltip text="Delete folder (requests move to root)">
                {#snippet children(p)}
                  <Button {...p} onclick={() => ws.deleteFolder(f.name, col.id)} variant="ghost" size="icon-xs" class="hover:text-red-400">✕</Button>
                {/snippet}
              </Tooltip>
            </span>
          </div>
          {#if !collapsed.has(key)}
            {#each f.requests as req, i (req.id)}
              {@render reqRow(col, req, true, f.name, f.requests[i + 1]?.id ?? null, i === f.requests.length - 1)}
            {/each}
            {#if f.requests.length === 0}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="relative py-1 pl-6"
                ondragover={(e) => {
                  if (!draggingId) return;
                  e.preventDefault();
                  e.stopPropagation();
                  dropFolderHeader = null;
                  dropRootHeader = null;
                  dropTarget = { colId: col.id, folder: f.name, beforeId: null };
                }}
                ondrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  commitDrop();
                }}
              >
                {#if lineEnd(col.id, f.name)}
                  <div class="drop-line" style="top: 2px"></div>
                {/if}
                <span class="hint">empty</span>
              </div>
            {/if}
          {/if}
        {/each}
        {/if}
      </div>
    {/each}
  </div>
</aside>

{#if showImport}
  <ImportModal onClose={() => (showImport = false)} />
{/if}

<!-- .drop-line styles live in app.css (global) — see note there about Tailwind v4 + Svelte. -->
