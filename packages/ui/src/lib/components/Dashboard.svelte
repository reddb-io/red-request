<script lang="ts">
  import { onMount } from "svelte";
  import { ws } from "../store.svelte";
  import * as repo from "../repo";
  import type { HistoryEntry } from "@red-requester/core";

  let history = $state<HistoryEntry[]>([]);
  let loading = $state(true);

  async function load() {
    loading = true;
    history = await repo.loadHistory(ws.activeColId ?? undefined).catch(() => []);
    loading = false;
  }
  onMount(load);

  const col = $derived(ws.activeCollection);

  const catalog = $derived.by(() => {
    const reqs = col?.requests ?? [];
    const byMethod: Record<string, number> = {};
    let withAuth = 0;
    let withScripts = 0;
    for (const r of reqs) {
      const key = r.kind === "http" ? r.method : r.kind.toUpperCase();
      byMethod[key] = (byMethod[key] ?? 0) + 1;
      if (r.auth.type !== "none" && r.auth.type !== "inherit") withAuth++;
      if (r.scripts.preRequest.trim() || r.scripts.postResponse.trim()) withScripts++;
    }
    return {
      total: reqs.length,
      byMethod,
      withAuth,
      withScripts,
      envs: col?.environments.length ?? 0,
    };
  });

  // Per-request stats from history (history is newest-first).
  const perReq = $derived.by(() => {
    const groups = new Map<string, HistoryEntry[]>();
    for (const h of history) {
      const arr = groups.get(h.reqId) ?? [];
      arr.push(h);
      groups.set(h.reqId, arr);
    }
    return (col?.requests ?? []).map((r) => {
      const runs = groups.get(r.id) ?? [];
      const okCount = runs.filter((x) => x.ok).length;
      const avgMs = runs.length
        ? Math.round(runs.reduce((s, x) => s + x.durationMs, 0) / runs.length)
        : 0;
      return {
        req: r,
        runs: runs.length,
        okRate: runs.length ? Math.round((okCount / runs.length) * 100) : null,
        avgMs,
        last: runs[0],
        // oldest → newest for the sparkline
        durations: [...runs].reverse().map((x) => x.durationMs),
      };
    });
  });

  const totals = $derived.by(() => ({
    runs: history.length,
    passed: history.reduce((s, h) => s + h.testsPassed, 0),
    failed: history.reduce((s, h) => s + h.testsFailed, 0),
  }));

  function sparkline(values: number[], w = 90, h = 22): string {
    if (values.length < 2) return "";
    const max = Math.max(...values, 1);
    const step = w / (values.length - 1);
    return values
      .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
      .join(" ");
  }

  function statusColor(s: number): string {
    if (s === 0) return "text-zinc-500";
    if (s < 300) return "text-emerald-400";
    if (s < 400) return "text-blue-400";
    if (s < 500) return "text-amber-400";
    return "text-red-400";
  }
</script>

<section class="flex h-full flex-col overflow-auto bg-[var(--color-bg-0)] p-5">
  <div class="mb-4 flex items-center justify-between">
    <h1 class="text-base font-semibold text-zinc-200">
      {col?.collection.name ?? "Dashboard"}
    </h1>
    <button
      onclick={load}
      class="rounded border border-[var(--color-bg-3)] px-2 py-1 text-xs text-zinc-300 hover:bg-[var(--color-bg-2)]"
      >{loading ? "…" : "Refresh"}</button
    >
  </div>

  <!-- Catalog -->
  <div class="mb-5 grid grid-cols-4 gap-3">
    <div class="rounded-lg border border-[var(--color-bg-3)] bg-[var(--color-bg-1)] p-3">
      <div class="text-2xl font-bold text-zinc-100">{catalog.total}</div>
      <div class="text-xs text-zinc-500">requests</div>
      <div class="mono mt-2 flex flex-wrap gap-1 text-[10px] text-zinc-400">
        {#each Object.entries(catalog.byMethod) as [m, n] (m)}
          <span class="rounded bg-[var(--color-bg-2)] px-1">{m} {n}</span>
        {/each}
      </div>
    </div>
    <div class="rounded-lg border border-[var(--color-bg-3)] bg-[var(--color-bg-1)] p-3">
      <div class="text-2xl font-bold text-zinc-100">{catalog.withAuth}</div>
      <div class="text-xs text-zinc-500">with auth</div>
    </div>
    <div class="rounded-lg border border-[var(--color-bg-3)] bg-[var(--color-bg-1)] p-3">
      <div class="text-2xl font-bold text-zinc-100">{catalog.withScripts}</div>
      <div class="text-xs text-zinc-500">with scripts</div>
    </div>
    <div class="rounded-lg border border-[var(--color-bg-3)] bg-[var(--color-bg-1)] p-3">
      <div class="text-2xl font-bold text-zinc-100">{catalog.envs}</div>
      <div class="text-xs text-zinc-500">environments</div>
    </div>
  </div>

  <!-- Tests aggregate -->
  <div class="mb-5 flex gap-4 rounded-lg border border-[var(--color-bg-3)] bg-[var(--color-bg-1)] p-3 text-sm">
    <span class="text-zinc-400">{totals.runs} runs recorded</span>
    <span class="text-emerald-400">{totals.passed} tests passed</span>
    <span class={totals.failed ? "text-red-400" : "text-zinc-500"}>{totals.failed} failed</span>
  </div>

  <!-- Per-request history + latency -->
  <h2 class="mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">
    History &amp; latency
  </h2>
  <table class="w-full text-sm">
    <thead class="text-left text-[11px] text-zinc-500">
      <tr class="border-b border-[var(--color-bg-3)]">
        <th class="py-1 pr-3 font-medium">Request</th>
        <th class="py-1 pr-3 font-medium">Runs</th>
        <th class="py-1 pr-3 font-medium">OK%</th>
        <th class="py-1 pr-3 font-medium">Avg</th>
        <th class="py-1 pr-3 font-medium">Last</th>
        <th class="py-1 font-medium">Latency</th>
      </tr>
    </thead>
    <tbody>
      {#each perReq as p (p.req.id)}
        <tr class="border-b border-[var(--color-bg-2)]">
          <td class="py-1.5 pr-3">
            <span class="mono text-[11px] text-zinc-500">{p.req.method}</span>
            <span class="text-zinc-200">{p.req.name}</span>
          </td>
          <td class="py-1.5 pr-3 text-zinc-300">{p.runs}</td>
          <td class="py-1.5 pr-3 {p.okRate === 100 ? 'text-emerald-400' : p.okRate === null ? 'text-zinc-600' : 'text-amber-400'}">
            {p.okRate === null ? "—" : `${p.okRate}%`}
          </td>
          <td class="mono py-1.5 pr-3 text-zinc-400">{p.runs ? `${p.avgMs}ms` : "—"}</td>
          <td class="mono py-1.5 pr-3 {p.last ? statusColor(p.last.status) : 'text-zinc-600'}">
            {p.last ? p.last.status : "—"}
          </td>
          <td class="py-1.5">
            {#if p.durations.length > 1}
              <svg width="90" height="22" class="overflow-visible">
                <polyline
                  points={sparkline(p.durations)}
                  fill="none"
                  stroke="var(--color-accent)"
                  stroke-width="1.5"
                />
              </svg>
            {:else}
              <span class="text-[10px] text-zinc-600">—</span>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if perReq.every((p) => p.runs === 0)}
    <p class="mt-3 text-xs text-zinc-600">No runs yet — send some requests to populate the dashboard.</p>
  {/if}
</section>
