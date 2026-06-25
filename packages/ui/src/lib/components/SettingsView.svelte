<script lang="ts">
  // Project-level settings: identity (rename), storage location, network-pool
  // summary, and the destructive danger zone. Moved here from the Sidebar's cog
  // menu now that the icon bar gives Settings a first-class home.
  import { ws } from "../store.svelte";
  import { projectLabel } from "../project";
  import { Button } from "./ui/button/index.js";
  import { Input } from "./ui/input/index.js";
  import { confirm } from "@tauri-apps/plugin-dialog";
  import * as yamlio from "../yaml-io";
  import * as repo from "../repo";
  import { fileMeta, type FileMeta } from "../rpc";
  import { onMount } from "svelte";
  import type { LoadedCollection } from "@red-request/core";
  import type { Component } from "svelte";
  import ProxiesPanel from "./ProxiesPanel.svelte";
  import EnvironmentsEditor from "./EnvironmentsEditor.svelte";
  import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
  import Database from "@lucide/svelte/icons/database";
  import Network from "@lucide/svelte/icons/network";
  import IdCard from "@lucide/svelte/icons/id-card";
  import Layers from "@lucide/svelte/icons/layers";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";

  type Section =
    | "general"
    | "environments"
    | "proxies"
    | "profiles"
    | "data"
    | "danger";
  type MenuItem = { id: Section; label: string; icon: Component; desc: string };
  let section = $state<Section>("general");
  const menu = $derived(
    [
      {
        id: "general",
        label: "General",
        icon: SlidersHorizontal,
        desc: "Project identity, where its data lives, and a snapshot of what's inside.",
      },
      {
        id: "environments",
        label: "Environments",
        icon: Layers,
        desc: "Project-wide variables and encrypted secrets. “Globals” always applies; a named environment layers on top — switch the active one from any request's URL bar.",
      },
      {
        id: "proxies",
        label: "Proxies",
        icon: Network,
        desc: "A project-wide pool of HTTP/HTTPS/SOCKS proxies — bind one to a profile or pick it per request. Host, port, user and password accept {{variables}}; use a sealed secret for the password.",
      },
      {
        id: "profiles",
        label: "Profiles",
        icon: IdCard,
        desc: "Reusable bundles of a User-Agent, extra headers and a proxy — pick one in any request's URL bar.",
      },
      {
        id: "data",
        label: "Data",
        icon: Database,
        desc: "Import and export collections — Postman, Insomnia, OpenAPI/HAR, or the git-friendly YAML tree. Secret values are never written.",
      },
      ...(ws.project?.is_project
        ? [
            {
              id: "danger",
              label: "Danger zone",
              icon: TriangleAlert,
              desc: "Irreversible actions for this project's stored data.",
            },
          ]
        : []),
    ] as MenuItem[]
  );
  const current = $derived(menu.find((m) => m.id === section) ?? menu[0]);

  let renaming = $state(false);
  let renameValue = $state("");
  let dataStatus = $state("");
  let dataBusy = $state(false);

  // --- database file info (size / last update / record counts) -------------
  let dbMeta = $state<FileMeta | null>(null);
  let dbCounts = $state<{ total: number; byKind: { label: string; count: number }[] } | null>(null);
  let dbMigrations = $state<{ applied: number; pending: number; failed: number } | null>(null);
  async function loadDbMeta() {
    const p = ws.project?.db_path;
    if (p) dbMeta = await fileMeta(p).catch(() => null);
    dbCounts = await repo.recordCounts().catch(() => null);
    dbMigrations = await repo.migrationSummary().catch(() => null);
  }
  onMount(loadDbMeta);
  const countsTitle = $derived(
    dbCounts ? dbCounts.byKind.map((k) => `${k.count} ${k.label}`).join(" · ") : ""
  );

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const u = ["KB", "MB", "GB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
  }
  function fmtWhen(ms: number): string {
    if (!ms) return "—";
    return new Date(ms).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  async function withStatus(label: string, fn: () => Promise<string | null>) {
    if (dataBusy) return;
    dataBusy = true;
    dataStatus = "";
    try {
      const msg = await fn();
      if (msg) dataStatus = msg;
    } catch (e) {
      dataStatus = `${label} failed: ${e instanceof Error ? e.message : e}`;
    } finally {
      dataBusy = false;
      void loadDbMeta();
    }
  }

  // Backups (full-store snapshots next to the .rdb).
  let backups = $state<Awaited<ReturnType<typeof ws.listBackups>>>([]);
  async function loadBackups() {
    backups = await ws.listBackups().catch(() => []);
  }
  onMount(loadBackups);
  function prettyBackup(name: string): string {
    const m = name.match(/^backup-(.+)\.json$/);
    if (!m) return name;
    const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? name : d.toLocaleString();
  }
  const backupNow = () =>
    withStatus("Backup", async () => {
      const p = await ws.createBackup();
      await loadBackups();
      return p ? "Backup saved" : "Store is empty — nothing to back up";
    });
  function restoreBackup(path: string, label: string) {
    void confirm(
      `Restore "${label}"?\n\nThis overwrites the current requests, environments and settings with the backup's contents.`,
      { title: "Restore backup", kind: "warning" }
    ).then((ok) => {
      if (!ok) return;
      void withStatus("Restore", async () => {
        await ws.restoreFromBackup(path);
        await loadBackups();
        return "Restored from backup";
      });
    });
  }
  function deleteBackup(path: string, label: string) {
    void confirm(`Delete backup "${label}"?\n\nThis cannot be undone.`, {
      title: "Delete backup",
      kind: "warning",
    }).then((ok) => {
      if (!ok) return;
      void withStatus("Delete", async () => {
        await ws.deleteBackup(path);
        await loadBackups();
        return "Backup deleted";
      });
    });
  }

  const exportYaml = () =>
    withStatus("Export", async () => {
      const path = await yamlio.exportAll(
        $state.snapshot(ws.collections) as LoadedCollection[],
        [$state.snapshot(ws.globals), ...$state.snapshot(ws.environments)]
      );
      return `Exported YAML tree → ${path}`;
    });
  const importYaml = () =>
    withStatus("Import", async () => {
      const n = await yamlio.importAll();
      await ws.reload();
      await ws.reloadEnvironments();
      return `Imported ${n} collection(s) from the YAML tree`;
    });
  const exportPostman = () =>
    withStatus("Export", async () => {
      const path = await ws.exportPostman();
      return path ? `Exported Postman collection → ${path}` : null;
    });
  const exportInsomnia = () =>
    withStatus("Export", async () => {
      const path = await ws.exportInsomnia();
      return path ? `Exported Insomnia export → ${path}` : null;
    });
  const importFile = () =>
    withStatus("Import", async () => {
      const kind = await ws.importFile();
      return kind ? `Imported a ${kind} from file` : null;
    });

  function startRename() {
    renameValue = projectLabel(ws.project);
    renaming = true;
  }
  async function commitRename() {
    if (renaming) await ws.renameProject(renameValue);
    renaming = false;
  }
  async function confirmDeleteProjectData() {
    const ok = await confirm(
      "Permanently delete all requests, collections and history for this project? This removes its .red/request data and cannot be undone (the rest of the folder is left untouched).",
      { title: "Delete project data", kind: "warning" }
    );
    if (ok) await ws.deleteProjectData();
  }

  const totals = $derived({
    collections: ws.collections.length,
    requests: ws.collections.reduce((s, c) => s + c.requests.length, 0),
    proxies: ws.proxies.length,
    profiles: ws.profiles.length,
  });
</script>

<section class="flex h-full bg-[var(--color-bg-0)]">
  <!-- Menu column ----------------------------------------------------------->
  <nav class="flex w-52 shrink-0 flex-col border-r border-border bg-[var(--color-bg-1)] p-3">
    <h1 class="mb-3 px-2 text-base font-semibold text-fg">Settings</h1>
    {#each menu as it (it.id)}
      {@const active = section === it.id}
      <button
        onclick={() => (section = it.id)}
        class="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors
          {active
          ? 'bg-[var(--color-bg-2)] text-[var(--color-brand)]'
          : 'text-fg-muted hover:bg-[var(--color-bg-2)] hover:text-fg'}"
        aria-current={active ? "page" : undefined}
      >
        <it.icon size={16} strokeWidth={active ? 2.4 : 2} />
        <span>{it.label}</span>
      </button>
    {/each}
  </nav>

  <!-- Content column -------------------------------------------------------->
  <div class="flex-1 overflow-auto p-5">
  <!-- Page header: title (outside any panel) + explanation, then the content -->
  <header class="mb-5">
    <h2 class="text-lg font-semibold text-fg-strong">{current.label}</h2>
    <p class="mt-1 max-w-2xl text-sm text-fg-muted">{current.desc}</p>
  </header>

  {#if section === "general"}
  <!-- Project identity ------------------------------------------------------>
  <div class="panel mb-4 p-4">
    <h2 class="label mb-3">Project</h2>
    <div class="flex items-center gap-3">
      <span class="w-24 text-xs text-fg-subtle">Name</span>
      {#if ws.project?.is_project && renaming}
        <!-- svelte-ignore a11y_autofocus -->
        <Input
          bind:value={renameValue}
          autofocus
          onblur={commitRename}
          onkeydown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") renaming = false;
          }}
          class="h-7 w-64"
        />
      {:else}
        <span class="text-sm text-fg">{projectLabel(ws.project)}</span>
        {#if ws.project?.is_project}
          <Button onclick={startRename} variant="ghost" size="xs">Rename</Button>
        {/if}
      {/if}
    </div>
    <div class="mt-2 flex items-center gap-3">
      <span class="w-24 text-xs text-fg-subtle">Store</span>
      <span class="mono truncate text-xs text-fg-muted" title={ws.project?.db_path}
        >{ws.project?.db_path ?? "—"}</span
      >
    </div>
    <div class="mt-2 flex items-center gap-3">
      <span class="w-24 text-xs text-fg-subtle">Switch</span>
      <Button onclick={() => ws.backToSelector()} variant="outline" size="xs"
        >Open another project…</Button
      >
    </div>
  </div>

  <!-- Contents summary ------------------------------------------------------>
  <div class="panel mb-4 p-4">
    <h2 class="label mb-3">Contents</h2>
    <div class="grid grid-cols-4 gap-3">
      <div>
        <div class="text-2xl font-bold text-fg-strong">{totals.collections}</div>
        <div class="text-xs text-fg-subtle">collections</div>
      </div>
      <div>
        <div class="text-2xl font-bold text-fg-strong">{totals.requests}</div>
        <div class="text-xs text-fg-subtle">requests</div>
      </div>
      <div>
        <div class="text-2xl font-bold text-fg-strong">{totals.proxies}</div>
        <div class="text-xs text-fg-subtle">proxies</div>
      </div>
      <div>
        <div class="text-2xl font-bold text-fg-strong">{totals.profiles}</div>
        <div class="text-xs text-fg-subtle">profiles</div>
      </div>
    </div>
    <p class="hint mt-3">
      Manage <button class="underline hover:text-fg" onclick={() => (section = "proxies")}
        >proxies</button
      >
      &amp;
      <button class="underline hover:text-fg" onclick={() => (section = "profiles")}
        >profiles</button
      > in their own sections.
    </p>
  </div>
  {:else if section === "environments"}
  <EnvironmentsEditor inline />
  {:else if section === "proxies"}
  <ProxiesPanel show="proxies" />
  {:else if section === "profiles"}
  <ProxiesPanel show="profiles" />
  {:else if section === "data"}
  <!-- Database file ---------------------------------------------------------->
  <div class="panel mb-4 p-4">
    <h2 class="label mb-3">Database</h2>
    <div class="flex items-center gap-3">
      <span class="w-24 shrink-0 text-xs text-fg-subtle">Store</span>
      <span class="mono truncate text-xs text-fg-muted" title={ws.project?.db_path}
        >{ws.project?.db_path ?? "—"}</span
      >
    </div>
    <div class="mt-2 flex items-center gap-3">
      <span class="w-24 shrink-0 text-xs text-fg-subtle">Size</span>
      <span class="text-xs text-fg">{dbMeta ? fmtBytes(dbMeta.size) : "…"}</span>
    </div>
    <div class="mt-2 flex items-center gap-3">
      <span class="w-24 shrink-0 text-xs text-fg-subtle">Updated</span>
      <span class="text-xs text-fg">{dbMeta ? fmtWhen(dbMeta.modifiedMs) : "…"}</span>
    </div>
    <div class="mt-2 flex items-center gap-3">
      <span class="w-24 shrink-0 text-xs text-fg-subtle">Records</span>
      <span class="text-xs text-fg" title={countsTitle}>
        {dbCounts ? `${dbCounts.total}` : "…"}
        {#if dbCounts}<span class="text-fg-faint">({countsTitle})</span>{/if}
      </span>
    </div>
    <div class="mt-2 flex items-center gap-3">
      <span class="w-24 shrink-0 text-xs text-fg-subtle">Migrations</span>
      <span class="text-xs text-fg">
        {#if dbMigrations}
          {dbMigrations.applied} applied
          {#if dbMigrations.pending > 0}<span class="text-amber-400"
              >· {dbMigrations.pending} pending</span
            >{/if}
          {#if dbMigrations.failed > 0}<span class="text-red-400"
              >· {dbMigrations.failed} failed</span
            >{/if}
          {#if dbMigrations.pending === 0 && dbMigrations.failed === 0}
            <span class="text-emerald-400">· up to date</span>
          {/if}
        {:else}…{/if}
      </span>
    </div>
  </div>

  <!-- Data: import / export ------------------------------------------------->
  <div class="panel mb-4 p-4">
    <div class="flex items-start gap-3">
      <span class="w-24 shrink-0 pt-1 text-xs text-fg-subtle">Import</span>
      <div class="flex flex-1 flex-wrap gap-2">
        <Button
          onclick={importFile}
          disabled={dataBusy}
          variant="outline"
          size="xs"
          title="Pick a Postman, Insomnia, OpenAPI/Swagger or HAR file (auto-detected)"
          >From file…</Button
        >
        <Button
          onclick={importYaml}
          disabled={dataBusy}
          variant="outline"
          size="xs"
          title="Read the git-friendly YAML tree (_exports) back into the store"
          >YAML tree</Button
        >
      </div>
    </div>

    <div class="mt-3 flex items-start gap-3">
      <span class="w-24 shrink-0 pt-1 text-xs text-fg-subtle">Export</span>
      <div class="flex flex-1 flex-wrap gap-2">
        <Button onclick={exportPostman} disabled={dataBusy} variant="outline" size="xs"
          >Postman</Button
        >
        <Button onclick={exportInsomnia} disabled={dataBusy} variant="outline" size="xs"
          >Insomnia</Button
        >
        <Button
          onclick={exportYaml}
          disabled={dataBusy}
          variant="outline"
          size="xs"
          title="Write a git-friendly YAML tree (no secret values)">YAML tree</Button
        >
      </div>
    </div>

    {#if dataStatus}
      <div class="hint mt-3 truncate text-fg-subtle" title={dataStatus}>{dataStatus}</div>
    {/if}
  </div>

  <!-- Backups --------------------------------------------------------------->
  <div class="panel mb-4 p-4">
    <div class="mb-2 flex items-center justify-between">
      <h2 class="label">Backups</h2>
      <Button onclick={backupNow} disabled={dataBusy} variant="outline" size="xs"
        >Backup now</Button
      >
    </div>
    <p class="hint mb-3 text-fg-subtle">
      A full snapshot of this store is saved to <span class="mono">backups/</span> once per launch
      and whenever you click Backup now. Restoring overwrites the current data.
    </p>
    {#if backups.length === 0}
      <div class="text-xs text-fg-faint">No backups yet.</div>
    {:else}
      <ul class="flex flex-col gap-1">
        {#each backups as b (b.path)}
          <li
            class="flex items-center justify-between gap-3 rounded px-2 py-1 hover:bg-[var(--color-bg-2)]"
          >
            <span class="truncate text-xs text-fg" title={b.path}>{prettyBackup(b.name)}</span>
            <div class="flex shrink-0 items-center gap-1">
              <Button
                onclick={() => restoreBackup(b.path, prettyBackup(b.name))}
                disabled={dataBusy}
                variant="ghost"
                size="xs">Restore</Button
              >
              <Button
                onclick={() => deleteBackup(b.path, prettyBackup(b.name))}
                disabled={dataBusy}
                variant="ghost"
                size="xs"
                aria-label="Delete backup"
                title="Delete backup">Delete</Button
              >
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {:else if section === "danger"}
  <!-- Danger zone ----------------------------------------------------------->
  <div class="rounded-lg border border-red-900/50 bg-red-950/20 p-4">
    <p class="mb-3 text-xs text-fg-muted">
      Permanently deletes this project's <span class="mono">.red/request</span> data (requests,
      collections, history). The rest of the folder is left untouched.
    </p>
    <Button onclick={confirmDeleteProjectData} variant="outline" size="xs"
      class="border-red-900/60 text-red-300 hover:bg-red-950/40">Delete project data…</Button
    >
  </div>
  {/if}
  </div>
</section>
