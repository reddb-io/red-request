<script lang="ts">
  import { ws } from "../store.svelte";
  import Tooltip from "./ui/Tooltip.svelte";
  import Menu from "./ui/Menu.svelte";
  import ImportModal from "./ui/ImportModal.svelte";
  import ConfirmActionModal from "./ui/ConfirmActionModal.svelte";
  import { Button } from "./ui/button/index.js";
  import { Input } from "./ui/input/index.js";
  import { Badge } from "./ui/badge/index.js";

  let showImport = $state(false);
  let collectionPendingDelete = $state<LoadedCollection | null>(null);
  import { projectLabel } from "../project";
  import {
    resolveCollectionRootOrder,
    type CollectionRootItem,
    type LoadedCollection,
  } from "@reddb-io/request-core";

  type SidebarRequest = LoadedCollection["requests"][number];
  type SidebarRootItem =
    | {
        kind: "request";
        entry: Extract<CollectionRootItem, { kind: "request" }>;
        request: SidebarRequest;
      }
    | {
        kind: "folder";
        entry: Extract<CollectionRootItem, { kind: "folder" }>;
        name: string;
        requests: SidebarRequest[];
      };

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
  let draggingFolder = $state<{ colId: string; name: string } | null>(null);
  let rootDropTarget = $state<{
    colId: string;
    before: CollectionRootItem | null;
  } | null>(null);

  function resetDrag() {
    draggingId = null;
    dropTarget = null;
    dropFolderHeader = null;
    dropRootHeader = null;
    rootDropTarget = null;
  }

  function resetFolderDrag() {
    draggingFolder = null;
    rootDropTarget = null;
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

  function onRootItemDragOver(
    e: DragEvent,
    col: LoadedCollection,
    item: CollectionRootItem,
    nextItem: CollectionRootItem | null
  ) {
    if (!draggingFolder && !draggingId) return false;
    e.preventDefault();
    e.stopPropagation();
    if (draggingFolder && draggingFolder.colId !== col.id) return true;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    rootDropTarget = {
      colId: col.id,
      before: e.clientY - rect.top < rect.height / 2 ? item : nextItem,
    };
    dropTarget = null;
    dropFolderHeader = null;
    dropRootHeader = null;
    return true;
  }

  function onFolderDragOver(
    e: DragEvent,
    col: LoadedCollection,
    folder: string,
    item: CollectionRootItem,
    nextItem: CollectionRootItem | null
  ) {
    if (draggingFolder) return onRootItemDragOver(e, col, item, nextItem);
    if (!draggingId) return false;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const offset = e.clientY - rect.top;
    if (offset < rect.height / 3 || offset > (rect.height * 2) / 3) {
      rootDropTarget = {
        colId: col.id,
        before: offset < rect.height / 3 ? item : nextItem,
      };
      dropTarget = null;
      dropFolderHeader = null;
    } else {
      rootDropTarget = null;
      dropRootHeader = null;
      dropFolderHeader = `${col.id}::${folder}`;
      dropTarget = { colId: col.id, folder, beforeId: null };
    }
    return true;
  }

  function commitRootDrop(col: LoadedCollection) {
    const target = rootDropTarget;
    if (target?.colId === col.id) {
      if (draggingFolder?.colId === col.id)
        void ws.reorderRootItem(
          { kind: "folder", name: draggingFolder.name },
          target.before,
          col.id
        );
      else if (draggingId)
        void ws.reorderRootRequest(draggingId, target.before, col.id);
    }
    resetDrag();
    resetFolderDrag();
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
  const rootLineBefore = (colId: string, item: CollectionRootItem) =>
    rootDropTarget?.colId === colId &&
    !!rootDropTarget.before &&
    (rootDropTarget.before.kind === "request"
      ? item.kind === "request" && rootDropTarget.before.id === item.id
      : item.kind === "folder" && rootDropTarget.before.name === item.name);
  const rootLineEnd = (colId: string) =>
    rootDropTarget?.colId === colId && rootDropTarget.before === null;
  const rootKey = (item: CollectionRootItem) =>
    item.kind === "request" ? `request:${item.id}` : `folder:${item.name}`;

  function toggle(key: string) {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    collapsed = new Set(collapsed);
  }

  function grouped(col: LoadedCollection) {
    const ordered = [...col.collection.folders];
    const extra = col.requests
      .map((r) => r.folder)
      .filter((name): name is string => !!name && !ordered.includes(name))
      .sort((a, b) => a.localeCompare(b));
    const names = [...ordered, ...extra];
    const folders = new Map(
      names.map((name) => [
        name,
        col.requests.filter((request) => request.folder === name),
      ])
    );
    const rootItems: SidebarRootItem[] = [];
    for (const entry of resolveCollectionRootOrder(
      col.collection,
      col.requests
    )) {
      if (entry.kind === "request") {
        const request = col.requests.find(
          (candidate) => candidate.id === entry.id && !candidate.folder
        );
        if (request) rootItems.push({ kind: "request", entry, request });
        continue;
      }
      rootItems.push({
        kind: "folder",
        entry,
        name: entry.name,
        requests: folders.get(entry.name) ?? [],
      });
    }
    return {
      rootItems,
    };
  }

  async function submitFolder(colId: string) {
    if (folderName.trim()) await ws.addFolder(folderName.trim(), colId);
    folderName = "";
    addingFolderFor = null;
  }

  // Create an empty collection and drop straight into its inline name field.
  async function newCollection() {
    if (ws.creatingCollection) return;
    const id = await ws.addCollection();
    if (!id) return;
    renamingColId = id;
    colRenameValue = "New Collection";
  }

  async function confirmDeleteCollection() {
    if (!collectionPendingDelete) return;
    await ws.deleteCollection(collectionPendingDelete.id);
    collectionPendingDelete = null;
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
        <Button
          {...p}
          onclick={newCollection}
          disabled={ws.creatingCollection}
          aria-busy={ws.creatingCollection}
          variant="outline"
          size="xs"
        >
          {ws.creatingCollection ? "Creating..." : "+ Collection"}
        </Button>
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
    rootEntry: CollectionRootItem | null,
    nextRootEntry: CollectionRootItem | null,
    isLastRoot: boolean,
  )}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="group/req relative"
      class:opacity-40={draggingId === req.id}
      ondragover={(e) => {
        if (rootEntry && onRootItemDragOver(e, col, rootEntry, nextRootEntry)) return;
        onRowDragOver(e, col.id, folder, req.id, nextId);
      }}
      ondrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (rootEntry && rootDropTarget) commitRootDrop(col);
        else commitDrop();
      }}
    >
      {#if rootEntry && rootLineBefore(col.id, rootEntry)}
        <div class="drop-line" style="top: -1px"></div>
      {:else if lineBefore(col.id, folder, req.id)}
        <div class="drop-line" style="top: -1px"></div>
      {/if}
      {#if (isLastRoot && rootLineEnd(col.id)) || (isLast && !rootEntry && lineEnd(col.id, folder))}
        <div class="drop-line" style="bottom: -1px"></div>
      {/if}
      <button
        onclick={() => ws.selectRequest(col.id, req.id)}
        ondblclick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          startRename(req);
        }}
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
          class:opacity-60={ws.deletingCollectionIds[col.id]}
          class:ring-1={dropRootHeader === col.id}
          class:ring-[var(--color-brand)]={dropRootHeader === col.id}
          aria-busy={!!ws.deletingCollectionIds[col.id]}
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
              ondblclick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                startRenameCol(col);
              }}
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
                  label: ws.deletingCollectionIds[col.id]
                    ? "Deleting collection..."
                    : "Delete collection",
                  onSelect: () => {
                    if (!ws.deletingCollectionIds[col.id])
                      collectionPendingDelete = col;
                  },
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

        {#each g.rootItems as item, rootIndex (rootKey(item.entry))}
          {@const nextRootEntry = g.rootItems[rootIndex + 1]?.entry ?? null}
          {@const isLastRoot = rootIndex === g.rootItems.length - 1}
          {#if item.kind === "request"}
            {@render reqRow(col, item.request, false, "", null, false, item.entry, nextRootEntry, isLastRoot)}
          {:else}
          {@const key = `${col.id}::${item.name}`}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="group/folder relative mt-0.5 flex items-center rounded"
            class:ring-1={dropFolderHeader === key}
            class:ring-[var(--color-brand)]={dropFolderHeader === key}
            ondragover={(e) => {
              onFolderDragOver(e, col, item.name, item.entry, nextRootEntry);
            }}
            ondragleave={() => {
              dropFolderHeader = null;
              rootDropTarget = null;
            }}
            ondrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (rootDropTarget) commitRootDrop(col);
              else commitDrop();
            }}
          >
            {#if rootLineBefore(col.id, item.entry)}
              <div class="drop-line" style="top: -1px"></div>
            {/if}
            {#if isLastRoot && rootLineEnd(col.id)}
              <div class="drop-line" style="bottom: -1px"></div>
            {/if}
            <button
              onclick={() => toggle(key)}
              draggable="true"
              ondragstart={(e) => {
                draggingFolder = { colId: col.id, name: item.name };
                e.dataTransfer?.setData("text/plain", item.name);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
              }}
              ondragend={resetFolderDrag}
              class="row flex-1 gap-1 px-2 py-1 text-xs"
              class:opacity-50={draggingFolder?.colId === col.id && draggingFolder.name === item.name}
            >
              <span class="text-fg-subtle">{collapsed.has(key) ? "▸" : "▾"}</span>
              <span class="truncate">{item.name}</span>
              <span class="text-xs text-fg-faint">{item.requests.length}</span>
            </button>
            <span class="absolute right-1 flex gap-1 text-fg-faint opacity-0 group-hover/folder:opacity-100">
              <Tooltip text="New request here">
                {#snippet children(p)}
                  <Button {...p} onclick={() => addAndRename(item.name, col.id)} variant="ghost" size="icon-xs">＋</Button>
                {/snippet}
              </Tooltip>
              <Tooltip text="Delete folder (requests move to root)">
                {#snippet children(p)}
                  <Button {...p} onclick={() => ws.deleteFolder(item.name, col.id)} variant="ghost" size="icon-xs" class="hover:text-red-400">✕</Button>
                {/snippet}
              </Tooltip>
            </span>
          </div>
          {#if !collapsed.has(key)}
            {#each item.requests as req, i (req.id)}
              {@render reqRow(col, req, true, item.name, item.requests[i + 1]?.id ?? null, i === item.requests.length - 1, null, null, false)}
            {/each}
            {#if item.requests.length === 0}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div
                class="relative py-1 pl-6"
                ondragover={(e) => {
                  if (!draggingId) return;
                  e.preventDefault();
                  e.stopPropagation();
                  dropFolderHeader = null;
                  dropRootHeader = null;
                  dropTarget = { colId: col.id, folder: item.name, beforeId: null };
                }}
                ondrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  commitDrop();
                }}
              >
                {#if lineEnd(col.id, item.name)}
                  <div class="drop-line" style="top: 2px"></div>
                {/if}
                <span class="hint">empty</span>
              </div>
            {/if}
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

{#if collectionPendingDelete}
  <ConfirmActionModal
    title="Delete collection"
    description={`Delete "${collectionPendingDelete.collection.name}" and every request, folder and history entry inside it? This cannot be undone.`}
    confirmLabel="Delete collection"
    busyLabel="Deleting collection..."
    destructive
    onCancel={() => (collectionPendingDelete = null)}
    onConfirm={confirmDeleteCollection}
  />
{/if}

<!-- .drop-line styles live in app.css (global) — see note there about Tailwind v4 + Svelte. -->
