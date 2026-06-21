<script lang="ts">
  import { ws } from "../store.svelte";
  import Tooltip from "./ui/Tooltip.svelte";
  import Menu from "./ui/Menu.svelte";
  import ImportModal from "./ui/ImportModal.svelte";
  import { Button } from "./ui/button/index.js";
  import { Input } from "./ui/input/index.js";
  import { Badge } from "./ui/badge/index.js";

  let showImport = $state(false);
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
    HEAD: "text-fg-muted",
    OPTIONS: "text-fg-muted",
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
      ? { label: req.method, color: methodColor[req.method] ?? "text-fg-muted" }
      : { label: req.kind.toUpperCase(), color: kindColor[req.kind] ?? "text-fg-muted" };

  // folder collapse state + inline "new folder" input
  let collapsed = $state(new Set<string>());
  let addingFolderFor = $state<string | null>(null);
  let folderName = $state("");

  // inline request rename
  let renamingId = $state<string | null>(null);
  let renameValue = $state("");
  function startRename(req: LoadedCollection["requests"][number]) {
    renamingId = req.id;
    renameValue = req.name;
  }
  async function commitRename() {
    if (renamingId) await ws.renameRequest(renamingId, renameValue);
    renamingId = null;
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

  // drag-and-drop requests between folders (within the active collection)
  let draggingId = $state<string | null>(null);
  let dropKey = $state<string | null>(null);
  function dropInto(colId: string, folder: string) {
    if (draggingId && ws.activeColId === colId) void ws.moveRequest(draggingId, folder);
    draggingId = null;
    dropKey = null;
  }

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
  class="flex h-full w-64 shrink-0 flex-col border-r border-border bg-[var(--color-bg-1)]"
>
  <div class="flex items-center gap-2 px-4 py-3">
    <span
      class="grid h-6 w-6 place-items-center rounded bg-[var(--color-brand)] text-sm font-bold text-black"
      >R</span
    >
    <div class="flex min-w-0 flex-col leading-tight">
      <span class="text-sm font-semibold">{brand.productName}</span>
      {#if ws.project}
        <Tooltip text="Switch project — {ws.project.db_path}" side="bottom">
          {#snippet children(p)}
            <button
              {...p}
              onclick={() => ws.backToSelector()}
              class="mono flex items-center gap-1 truncate text-xs text-fg-subtle hover:text-fg"
            >
              {projectLabel(ws.project)}
              <span class="text-fg-faint">⇄</span>
            </button>
          {/snippet}
        </Tooltip>
      {/if}
    </div>
  </div>

  <div class="flex gap-1 px-2 pb-2">
    {#each ["requests", "dashboard"] as const as v (v)}
      <button onclick={() => (ws.view = v)} class="seg" class:is-active={ws.view === v}
        >{v}</button
      >
    {/each}
  </div>

  {#snippet reqRow(col: LoadedCollection, req: LoadedCollection["requests"][number], indent: boolean)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="group/req relative"
      class:opacity-40={draggingId === req.id}
      draggable="true"
      ondragstart={() => (draggingId = req.id)}
      ondragend={() => {
        draggingId = null;
        dropKey = null;
      }}
    >
      <button
        onclick={() => ws.selectRequest(col.id, req.id)}
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
          class:ring-1={dropKey === `${col.id}::root`}
          class:ring-[var(--color-brand)]={dropKey === `${col.id}::root`}
          ondragover={(e) => {
            if (!draggingId) return;
            e.preventDefault();
            dropKey = `${col.id}::root`;
          }}
          ondragleave={() => (dropKey = null)}
          ondrop={(e) => {
            e.preventDefault();
            dropInto(col.id, "");
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
            <span class="label truncate">
              {col.collection.name}
            </span>
          {/if}
          <span class="flex shrink-0 items-center gap-1 text-fg-subtle">
            <Tooltip text="New request">
              {#snippet children(p)}
                <Button {...p} onclick={() => ws.addRequest("")} variant="ghost" size="icon-xs">＋</Button>
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
                { label: "Import cURL…", onSelect: () => (showImport = true) },
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

        {#each g.root as req (req.id)}
          {@render reqRow(col, req, false)}
        {/each}

        {#each g.folders as f (f.name)}
          {@const key = `${col.id}::${f.name}`}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="group/folder relative mt-0.5 flex items-center rounded"
            class:ring-1={dropKey === key}
            class:ring-[var(--color-brand)]={dropKey === key}
            ondragover={(e) => {
              if (!draggingId) return;
              e.preventDefault();
              dropKey = key;
            }}
            ondragleave={() => (dropKey = null)}
            ondrop={(e) => {
              e.preventDefault();
              dropInto(col.id, f.name);
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
                  <Button {...p} onclick={() => ws.addRequest(f.name)} variant="ghost" size="icon-xs">＋</Button>
                {/snippet}
              </Tooltip>
              <Tooltip text="Delete folder (requests move to root)">
                {#snippet children(p)}
                  <Button {...p} onclick={() => ws.deleteFolder(f.name)} variant="ghost" size="icon-xs" class="hover:text-red-400">✕</Button>
                {/snippet}
              </Tooltip>
            </span>
          </div>
          {#if !collapsed.has(key)}
            {#each f.requests as req (req.id)}
              {@render reqRow(col, req, true)}
            {/each}
            {#if f.requests.length === 0}
              <div class="hint py-1 pl-6">empty</div>
            {/if}
          {/if}
        {/each}
      </div>
    {/each}
  </div>

  <div class="border-t border-border p-2">
    <div class="flex gap-1">
      <Button
        onclick={doExport}
        variant="outline"
        size="xs"
        class="flex-1"
        title="Write a git-friendly YAML tree (no secret values)">Export YAML</Button
      >
      <Button
        onclick={doImport}
        variant="outline"
        size="xs"
        class="flex-1"
        title="Read the YAML tree back into the store">Import</Button
      >
    </div>
    {#if status}
      <div class="hint mt-1 truncate text-fg-subtle" title={status}>{status}</div>
    {/if}
  </div>
</aside>

{#if showImport}
  <ImportModal onClose={() => (showImport = false)} />
{/if}
