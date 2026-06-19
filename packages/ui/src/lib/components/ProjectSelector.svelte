<script lang="ts">
  import { onMount } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { ws } from "../store.svelte";
  import { brand } from "../brand.generated";
  import { recentList, type RecentProject } from "../project";

  let recents = $state<RecentProject[]>([]);
  let busy = $state(false);
  let query = $state("");

  onMount(async () => {
    recents = await recentList().catch(() => []);
  });

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return recents;
    return recents.filter(
      (r) => r.name.toLowerCase().includes(q) || r.dir.toLowerCase().includes(q)
    );
  });

  async function choose(dir: string | null) {
    if (busy) return;
    busy = true;
    await ws.chooseProject(dir);
  }

  async function openFolder() {
    const picked = await open({ directory: true, title: "Open a project folder" });
    if (typeof picked === "string") await choose(picked);
  }

  function ago(sec: number): string {
    const s = Math.floor(Date.now() / 1000 - sec);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
</script>

<div class="grid h-screen place-items-center bg-[var(--color-bg-0)] px-6">
  <div class="w-[640px]">
    <div class="mb-6 flex items-center gap-3">
      <span
        class="grid h-9 w-9 place-items-center rounded-lg bg-[var(--color-accent)] text-lg font-bold text-black"
        >R</span
      >
      <div>
        <h1 class="text-lg font-semibold text-zinc-100">{brand.productName}</h1>
        <p class="text-xs text-zinc-500">Open a project</p>
      </div>
    </div>

    <div class="mb-3 flex gap-2">
      <input
        bind:value={query}
        placeholder="Search projects…"
        class="mono flex-1 rounded-lg bg-[var(--color-bg-2)] px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
      />
      <button
        onclick={openFolder}
        disabled={busy}
        class="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-black disabled:opacity-50"
        >Open folder…</button
      >
      <button
        onclick={() => choose(null)}
        disabled={busy}
        class="rounded-lg border border-[var(--color-bg-3)] px-3 py-2 text-sm text-zinc-300 hover:bg-[var(--color-bg-2)] disabled:opacity-50"
        title="Use the global store (~/.red/request/app.rdb)">Global</button
      >
    </div>

    <div class="mb-1.5 flex items-center justify-between px-1">
      <span class="text-[10px] tracking-wide text-zinc-500 uppercase">Recent</span>
      {#if recents.length}
        <span class="text-[10px] text-zinc-600">
          {filtered.length}{filtered.length !== recents.length ? `/${recents.length}` : ""}
        </span>
      {/if}
    </div>

    {#if recents.length === 0}
      <div
        class="rounded-lg border border-[var(--color-bg-3)] bg-[var(--color-bg-1)] px-3 py-6 text-center text-xs text-zinc-600"
      >
        No recent projects. Open a folder to start one — its data lives in
        <code class="mono">.red/request/app.rdb</code>.
      </div>
    {:else if filtered.length === 0}
      <div
        class="rounded-lg border border-[var(--color-bg-3)] bg-[var(--color-bg-1)] px-3 py-6 text-center text-xs text-zinc-600"
      >
        No projects match “{query}”.
      </div>
    {:else}
      <div class="grid max-h-[52vh] grid-cols-2 gap-2 overflow-y-auto pr-1">
        {#each filtered as r (r.dir)}
          <button
            onclick={() => choose(r.dir)}
            disabled={busy}
            class="group flex flex-col items-start gap-1 rounded-lg border border-[var(--color-bg-3)] bg-[var(--color-bg-1)] p-3 text-left transition hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-2)] disabled:opacity-50"
          >
            <span class="flex w-full items-center gap-2">
              <span class="text-zinc-500 group-hover:text-[var(--color-accent)]">▸</span>
              <span class="truncate text-sm font-medium text-zinc-100">{r.name}</span>
            </span>
            <span class="mono w-full truncate text-[10px] text-zinc-600">{r.dir}</span>
            <span class="text-[10px] text-zinc-600">{ago(r.last_opened)}</span>
          </button>
        {/each}
      </div>
    {/if}

    {#if busy}
      <p class="mt-3 text-center text-xs text-zinc-500">Opening…</p>
    {/if}
  </div>
</div>
