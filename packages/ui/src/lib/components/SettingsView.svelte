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
  import type { LoadedCollection } from "@reddb-io/request-core";
  import type { Component } from "svelte";
  import type { VcsCommit, VcsDiffSummary } from "../repo";
  import type { SettingsSection } from "../store.svelte";
  import ProxiesPanel from "./ProxiesPanel.svelte";
  import EnvironmentsEditor from "./EnvironmentsEditor.svelte";
  import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
  import Database from "@lucide/svelte/icons/database";
  import Network from "@lucide/svelte/icons/network";
  import IdCard from "@lucide/svelte/icons/id-card";
  import Layers from "@lucide/svelte/icons/layers";
  import History from "@lucide/svelte/icons/history";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";

  type MenuItem = { id: SettingsSection; label: string; icon: Component; desc: string };
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
        id: "history",
        label: "History",
        icon: History,
        desc: "Project-wide restore points: inspect what changed, who created the checkpoint, and restore the whole project to a previous point.",
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
  const section = $derived(ws.settingsSection);
  const current = $derived(menu.find((m) => m.id === section) ?? menu[0]);

  let renaming = $state(false);
  let renameValue = $state("");
  let dataStatus = $state("");
  let dataBusy = $state(false);
  let redUiSaving = $state(false);
  let redUiError = $state("");
  let historyBusy = $state(false);
  let historyRestoring = $state(false);
  let historyLoaded = $state(false);
  let historyStatus = $state("");
  let commits = $state<VcsCommit[]>([]);
  let selectedCommitHash = $state<string | null>(null);
  let selectedDiff = $state<VcsDiffSummary | null>(null);
  let selectedDiffLoading = $state(false);
  let selectedDiffTicket = 0;

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
  function shortHash(hash: string): string {
    return hash.slice(0, 8);
  }

  function commitLabel(commit: VcsCommit): string {
    return commit.message.trim() || "edit";
  }

  const selectedCommit = $derived(
    commits.find((commit) => commit.hash === selectedCommitHash) ?? commits[0] ?? null
  );
  const headHash = $derived(commits[0]?.hash ?? null);

  async function loadProjectHistory() {
    if (historyBusy) return;
    historyBusy = true;
    historyStatus = "";
    try {
      await ws.flushSave();
      await repo.flushPendingCommit().catch(() => null);
      const next = await repo.listCommits(100);
      commits = next;
      if (!next.some((commit) => commit.hash === selectedCommitHash)) {
        selectedCommitHash = next[0]?.hash ?? null;
      }
      historyLoaded = true;
      await loadSelectedDiff(selectedCommitHash);
    } catch (e) {
      historyStatus = `Could not load project history: ${e instanceof Error ? e.message : e}`;
    } finally {
      historyBusy = false;
    }
  }

  async function loadSelectedDiff(hash: string | null) {
    const ticket = ++selectedDiffTicket;
    selectedDiff = null;
    selectedDiffLoading = false;
    if (!hash) return;
    const commit = commits.find((candidate) => candidate.hash === hash);
    if (!commit) return;
    const index = commits.findIndex((candidate) => candidate.hash === hash);
    const parent = commit.parents[0] ?? commits[index + 1]?.hash ?? null;
    if (!parent) return;
    selectedDiffLoading = true;
    try {
      const diff = await repo.commitDiffSummary(parent, commit.hash);
      if (ticket === selectedDiffTicket) selectedDiff = diff;
    } finally {
      if (ticket === selectedDiffTicket) selectedDiffLoading = false;
    }
  }

  $effect(() => {
    if (section !== "history" || historyLoaded || historyBusy) return;
    void loadProjectHistory();
  });

  $effect(() => {
    if (section !== "history") return;
    void loadSelectedDiff(selectedCommitHash);
  });

  async function restoreSelectedCommit() {
    const commit = selectedCommit;
    if (!commit || historyRestoring) return;
    const ok = await confirm(
      `Restore the whole project to "${commitLabel(commit)}" from ${fmtWhen(commit.timestampMs)}?\n\nThis rewinds requests, collections, environments and settings to that checkpoint. A newer checkpoint can still be selected again if it remains in the history list.`,
      { title: "Restore project checkpoint", kind: "warning" }
    );
    if (!ok) return;
    historyRestoring = true;
    historyStatus = "";
    try {
      await ws.flushSave();
      await repo.flushPendingCommit();
      await repo.resetProjectToCommit(commit.hash);
      await ws.reload();
      await ws.reloadEnvironments();
      await loadDbMeta();
      historyLoaded = false;
      await loadProjectHistory();
      historyStatus = `Restored project to ${shortHash(commit.hash)}`;
    } catch (e) {
      historyStatus = `Restore failed: ${e instanceof Error ? e.message : e}`;
    } finally {
      historyRestoring = false;
    }
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

  let includeSecrets = $state(false);
  const exportYaml = () =>
    withStatus("Export", async () => {
      const path = await yamlio.exportAll(
        $state.snapshot(ws.collections) as LoadedCollection[],
        [$state.snapshot(ws.globals), ...$state.snapshot(ws.environments)],
        { includeSecrets }
      );
      return includeSecrets
        ? `Exported YAML tree with PLAINTEXT secrets → ${path}`
        : `Exported YAML tree → ${path}`;
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

  async function toggleRedUi(enabled: boolean) {
    if (redUiSaving) return;
    redUiSaving = true;
    redUiError = "";
    try {
      await ws.setRedUiEnabled(enabled);
    } catch (e) {
      redUiError = e instanceof Error ? e.message : String(e);
      ws.redUiEnabled = !enabled;
    } finally {
      redUiSaving = false;
    }
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
        onclick={() => (ws.settingsSection = it.id)}
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
      Manage <button class="underline hover:text-fg" onclick={() => (ws.settingsSection = "proxies")}
        >proxies</button
      >
      &amp;
      <button class="underline hover:text-fg" onclick={() => (ws.settingsSection = "profiles")}
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
  {:else if section === "history"}
  <div class="panel mb-4 overflow-hidden">
    <div class="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div>
        <h2 class="label">Project checkpoints</h2>
        <p class="hint mt-1 text-fg-subtle">
          Native RedDB commits for the whole request store. Restoring affects the entire project.
        </p>
      </div>
      <Button onclick={loadProjectHistory} disabled={historyBusy || historyRestoring} variant="outline" size="xs">
        {historyBusy ? "Refreshing..." : "Refresh"}
      </Button>
    </div>

    {#if commits.length === 0}
      <div class="px-4 py-8 text-center text-xs text-fg-faint">
        {historyBusy ? "Loading project history..." : "No checkpoints yet. Edits create restore points automatically."}
      </div>
    {:else}
      <div class="grid min-h-[420px] grid-cols-[minmax(260px,360px)_1fr]">
        <ul class="max-h-[560px] overflow-auto border-r border-border py-2">
          {#each commits as commit, i (commit.hash)}
            {@const active = selectedCommitHash === commit.hash}
            <li>
              <button
                class="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-[var(--color-bg-2)] {active ? 'bg-[var(--color-bg-2)]' : ''}"
                onclick={() => (selectedCommitHash = commit.hash)}
              >
                <span
                  class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full border {i === 0 ? 'border-accent bg-accent' : 'border-border bg-bg'}"
                ></span>
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-2">
                    <span class="truncate text-xs font-medium text-fg">{i === 0 ? "Current" : commitLabel(commit)}</span>
                    {#if i === 0}
                      <span class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-fg">HEAD</span>
                    {/if}
                  </span>
                  {#if i === 0 && commitLabel(commit) !== "Current"}
                    <span class="mt-0.5 block truncate text-[11px] text-muted-fg">{commitLabel(commit)}</span>
                  {/if}
                  <span class="mt-0.5 block text-[11px] text-fg-faint">
                    {fmtWhen(commit.timestampMs)} · {commit.author || "unknown"} · <span class="mono">{shortHash(commit.hash)}</span>
                  </span>
                </span>
              </button>
            </li>
          {/each}
        </ul>

        <div class="min-w-0 p-4">
          {#if selectedCommit}
            <div class="mb-4 flex items-start justify-between gap-4">
              <div class="min-w-0">
                <h3 class="truncate text-sm font-semibold text-fg">{commitLabel(selectedCommit)}</h3>
                <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-subtle">
                  <span>{fmtWhen(selectedCommit.timestampMs)}</span>
                  <span>by {selectedCommit.author || "unknown"}</span>
                  <span class="mono">{selectedCommit.hash}</span>
                </div>
              </div>
              <Button
                onclick={restoreSelectedCommit}
                disabled={historyRestoring || selectedCommit.hash === headHash}
                size="xs"
                variant={selectedCommit.hash === headHash ? "outline" : "default"}
              >
                {selectedCommit.hash === headHash
                  ? "Current checkpoint"
                  : historyRestoring
                    ? "Restoring..."
                    : "Restore project"}
              </Button>
            </div>

            <div class="mb-4 grid grid-cols-3 gap-3">
              <div class="rounded border border-border bg-[var(--color-bg-1)] p-3">
                <div class="text-lg font-semibold text-fg">{selectedDiff?.added ?? 0}</div>
                <div class="text-xs text-fg-subtle">added</div>
              </div>
              <div class="rounded border border-border bg-[var(--color-bg-1)] p-3">
                <div class="text-lg font-semibold text-fg">{selectedDiff?.modified ?? 0}</div>
                <div class="text-xs text-fg-subtle">modified</div>
              </div>
              <div class="rounded border border-border bg-[var(--color-bg-1)] p-3">
                <div class="text-lg font-semibold text-fg">{selectedDiff?.removed ?? 0}</div>
                <div class="text-xs text-fg-subtle">removed</div>
              </div>
            </div>

            <div class="rounded border border-border">
              <div class="border-b border-border px-3 py-2 text-xs font-medium text-fg">Changed entities</div>
              {#if selectedDiffLoading}
                <div class="px-3 py-4 text-xs text-fg-faint">Loading diff...</div>
              {:else if !selectedDiff}
                <div class="px-3 py-4 text-xs text-fg-faint">No diff available for this checkpoint.</div>
              {:else if selectedDiff.entries.length === 0}
                <div class="px-3 py-4 text-xs text-fg-faint">No entity-level changes reported.</div>
              {:else}
                <ul class="max-h-72 overflow-auto">
                  {#each selectedDiff.entries.slice(0, 80) as entry, i (`${entry.collection}.${entry.entityId}.${i}`)}
                    <li class="grid grid-cols-[86px_150px_1fr] gap-3 border-b border-border/70 px-3 py-2 last:border-b-0">
                      <span class="text-xs capitalize text-fg">{entry.change}</span>
                      <span class="mono truncate text-xs text-muted-fg" title={entry.collection}>{entry.collection}</span>
                      <span class="mono truncate text-xs text-fg-subtle" title={entry.entityId}>{entry.entityId}</span>
                    </li>
                  {/each}
                </ul>
                {#if selectedDiff.entries.length > 80}
                  <div class="border-t border-border px-3 py-2 text-xs text-fg-faint">
                    Showing 80 of {selectedDiff.entries.length} changes.
                  </div>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/if}

    {#if historyStatus}
      <div class="border-t border-border px-4 py-2 text-xs text-fg-subtle">{historyStatus}</div>
    {/if}
  </div>
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

  <!-- Embedded red-ui -------------------------------------------------------->
  <div class="panel mb-4 p-4">
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="label mb-1">Database browser</h2>
        <p class="hint max-w-2xl text-fg-subtle">
          Show a DB icon in the left rail for inspecting this request store with red-ui.
        </p>
      </div>
      <label class="inline-flex cursor-pointer items-center gap-2 text-xs text-fg">
        <input
          type="checkbox"
          class="accent-accent"
          checked={ws.redUiEnabled}
          disabled={redUiSaving}
          onchange={(e) => toggleRedUi((e.currentTarget as HTMLInputElement).checked)}
        />
        Enabled
      </label>
    </div>
    {#if redUiError}
      <p class="mono mt-2 text-xs text-red-300">{redUiError}</p>
    {/if}
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
          title="Read the git-friendly YAML tree (exports) back into the store"
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
          title="Write a git-friendly YAML tree">YAML tree</Button
        >
        <label
          class="flex cursor-pointer items-center gap-1.5 pl-1 text-xs text-fg-subtle"
          title="When on, the YAML export also writes decrypted secret values in PLAINTEXT — for migrating to another machine. Never commit that to git or share it."
        >
          <input type="checkbox" bind:checked={includeSecrets} class="accent-accent" />
          include secrets {#if includeSecrets}<span class="text-amber-500">(plaintext!)</span>{/if}
        </label>
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
    <Button
      onclick={confirmDeleteProjectData}
      disabled={ws.deletingProjectData}
      aria-busy={ws.deletingProjectData}
      variant="outline"
      size="xs"
      class="border-red-900/60 text-red-300 hover:bg-red-950/40"
    >
      {ws.deletingProjectData ? "Deleting project data..." : "Delete project data..."}
    </Button>
  </div>
  {/if}
  </div>
</section>
