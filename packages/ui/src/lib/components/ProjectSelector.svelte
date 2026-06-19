<script lang="ts">
  import { onMount } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { ws } from "../store.svelte";
  import { brand } from "../brand.generated";
  import { recentList, type RecentProject } from "../project";

  let recents = $state<RecentProject[]>([]);
  let busy = $state(false);

  onMount(async () => {
    recents = await recentList().catch(() => []);
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
  <div class="w-[460px]">
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
      <button
        onclick={openFolder}
        disabled={busy}
        class="flex-1 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-black disabled:opacity-50"
        >Open folder…</button
      >
      <button
        onclick={() => choose(null)}
        disabled={busy}
        class="rounded-lg border border-[var(--color-bg-3)] px-3 py-2 text-sm text-zinc-300 hover:bg-[var(--color-bg-2)] disabled:opacity-50"
        title="Use the global store (~/.red/request/app.rdb)">Global</button
      >
    </div>

    <div class="rounded-lg border border-[var(--color-bg-3)] bg-[var(--color-bg-1)]">
      <div class="border-b border-[var(--color-bg-3)] px-3 py-2 text-[10px] tracking-wide text-zinc-500 uppercase">
        Recent
      </div>
      {#if recents.length === 0}
        <div class="px-3 py-4 text-xs text-zinc-600">
          No recent projects. Open a folder to start one — its data lives in
          <code class="mono">.red/request/app.rdb</code>.
        </div>
      {:else}
        <div class="max-h-[40vh] overflow-y-auto">
          {#each recents as r (r.dir)}
            <button
              onclick={() => choose(r.dir)}
              disabled={busy}
              class="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-[var(--color-bg-2)] disabled:opacity-50"
            >
              <span class="min-w-0">
                <span class="block truncate text-sm text-zinc-200">{r.name}</span>
                <span class="mono block truncate text-[10px] text-zinc-600">{r.dir}</span>
              </span>
              <span class="shrink-0 pl-3 text-[10px] text-zinc-600">{ago(r.last_opened)}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    {#if busy}
      <p class="mt-3 text-center text-xs text-zinc-500">Opening…</p>
    {/if}
  </div>
</div>
