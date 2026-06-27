<script lang="ts">
  import { onMount } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { ws } from "../store.svelte";
  import { brand } from "../brand.generated";
  import { recentList, recentPin, type RecentProject } from "../project";
  import { appVersion, reddbVersion } from "../rpc";
  import StageBackground from "./StageBackground.svelte";
  import Tooltip from "./ui/Tooltip.svelte";
  import { Button } from "./ui/button/index.js";
  import { Input } from "./ui/input/index.js";

  let recents = $state<RecentProject[]>([]);
  let busy = $state(false);
  let query = $state("");
  let connectionString = $state("");
  let appVer = $state<string | null>(null);
  let reddbVer = $state<string | null>(null);

  onMount(async () => {
    recents = await recentList().catch(() => []);
    appVer = await appVersion().catch(() => null);
    reddbVer = await reddbVersion().catch(() => null);
  });

  // Pinned first, then most-recently-used.
  const sorted = $derived(
    [...recents].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || b.last_opened - a.last_opened
    )
  );

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (r) => r.name.toLowerCase().includes(q) || r.dir.toLowerCase().includes(q)
    );
  });

  async function togglePin(r: RecentProject) {
    r.pinned = !r.pinned;
    recents = [...recents];
    await recentPin(r.dir, r.pinned).catch(() => {});
  }

  function fmtDate(sec: number): string {
    return new Date(sec * 1000).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  async function choose(dir: string | null) {
    if (busy) return;
    busy = true;
    try {
      await ws.chooseProject(dir);
    } finally {
      busy = false;
    }
  }

  async function openFolder() {
    const picked = await open({ directory: true, title: "Open a project folder" });
    if (typeof picked === "string") await choose(picked);
  }

  async function connectString() {
    if (busy || !connectionString.trim()) return;
    busy = true;
    try {
      await ws.chooseConnectionString(connectionString);
    } finally {
      busy = false;
    }
  }
</script>

<div class="relative h-full overflow-hidden bg-[var(--color-bg-0)]">
  <StageBackground />
  <div class="relative z-10 grid h-full place-items-center px-6">
    <div class="w-[640px]">
    <div class="mb-5 flex items-center gap-2.5">
      <span
        class="grid h-7 w-7 place-items-center rounded-md bg-[var(--color-brand)] text-sm font-bold text-black"
        >{brand.monogram}</span
      >
      <div class="leading-tight">
        <h1 class="text-base font-semibold text-fg-strong">{brand.productName}</h1>
        <p class="text-xs text-fg-subtle">Open a project</p>
      </div>
    </div>

    <div class="mb-3 flex gap-2">
      <Input
        bind:value={query}
        placeholder="Search projects…"
        class="h-7 flex-1"
      />
      <Button
        onclick={openFolder}
        disabled={busy}
        size="xs"
        >Open folder…</Button
      >
      <Button
        onclick={() => choose(null)}
        disabled={busy}
        variant="outline"
        size="xs"
        title="Use the global store (~/.red/request/app.rdb)">Global</Button
      >
    </div>

    <div class="mb-4 flex gap-2">
      <Input
        bind:value={connectionString}
        placeholder="https://host:port, red+ws://host/redwire, or docker://container"
        class="h-7 flex-1"
        onkeydown={(event) => {
          if (event.key === "Enter") void connectString();
        }}
      />
      <Button
        onclick={connectString}
        disabled={busy || !connectionString.trim()}
        variant="outline"
        size="xs">Connect</Button
      >
    </div>

    <div class="mb-1.5 flex items-center justify-between px-1">
      <span class="label">Recent</span>
      {#if recents.length}
        <span class="hint text-fg-faint">
          {filtered.length}{filtered.length !== recents.length ? `/${recents.length}` : ""}
        </span>
      {/if}
    </div>

    {#if recents.length === 0}
      <div
        class="panel px-3 py-6 text-center text-xs text-fg-faint"
      >
        No recent projects. Open a folder to start one — its data lives in
        <code class="mono">.red/request/app.rdb</code>.
      </div>
    {:else if filtered.length === 0}
      <div
        class="panel px-3 py-6 text-center text-xs text-fg-faint"
      >
        No projects match “{query}”.
      </div>
    {:else}
      <div class="grid max-h-[52vh] grid-cols-2 gap-2 overflow-y-auto pr-1">
        {#each filtered as r (r.dir)}
          <div class="group relative">
            <button
              onclick={() => choose(r.dir)}
              disabled={busy}
              class="panel flex w-full flex-col items-start gap-1 p-3 pr-8 text-left transition hover:border-[var(--color-brand)] hover:bg-[var(--color-bg-2)] disabled:opacity-50"
            >
              <span class="flex w-full items-center gap-2">
                <span class="text-fg-subtle group-hover:text-[var(--color-brand)]">▸</span>
                <span class="truncate text-sm font-medium text-fg-strong">{r.name}</span>
              </span>
              <span class="mono w-full truncate text-xs text-fg-faint">{r.dir}</span>
              <span class="flex items-center gap-1.5 text-xs text-fg-faint">
                <span>{r.request_count} {r.request_count === 1 ? "request" : "requests"}</span>
                <span>·</span>
                <span>{fmtDate(r.last_opened)}</span>
              </span>
            </button>
            <Tooltip text={r.pinned ? "Unpin" : "Pin to top"}>
              {#snippet children(p)}
                <Button
                  {...p}
                  onclick={() => togglePin(r)}
                  variant="ghost"
                  size="icon-xs"
                  class="absolute top-2 right-2 {r.pinned
                    ? 'text-[var(--color-brand)]'
                    : ''}"
                >
                  {r.pinned ? "★" : "☆"}
                </Button>
              {/snippet}
            </Tooltip>
          </div>
        {/each}
      </div>
    {/if}

    </div>
  </div>

  <!-- Version footer -->
  <div
    class="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center justify-center gap-2 px-4 py-2.5 text-[11px] text-fg-faint"
  >
    <span class="mono">{brand.binaryName} v{appVer ?? "…"}</span>
    <span class="text-fg-faint/50">·</span>
    <span class="mono">reddb v{reddbVer ?? "…"}</span>
  </div>
</div>
