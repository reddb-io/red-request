<script lang="ts">
  import { onMount } from "svelte";
  import { ws } from "../store.svelte";
  import * as repo from "../repo";
  import type { HistoryEntry } from "@reddb-io/request-core";
  import { networkIdentityRows } from "../dashboardMetrics";
  import { Button } from "./ui/button/index.js";

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

  const networkRows = $derived(networkIdentityRows(history));

  function sparkline(values: number[], w = 90, h = 22): string {
    if (values.length < 2) return "";
    const max = Math.max(...values, 1);
    const step = w / (values.length - 1);
    return values
      .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
      .join(" ");
  }

  function statusColor(s: number): string {
    if (s === 0) return "text-fg-subtle";
    if (s < 300) return "text-emerald-400";
    if (s < 400) return "text-blue-400";
    if (s < 500) return "text-amber-400";
    return "text-red-400";
  }
</script>

<section class="flex flex-col">
  <div class="mb-4 flex items-center justify-between">
    <h2 class="label">Dashboard{col ? ` · ${col.collection.name}` : ""}</h2>
    <Button
      onclick={load}
      variant="outline"
      size="xs"
      >{loading ? "…" : "Refresh"}</Button
    >
  </div>

  <!-- Catalog -->
  <div class="mb-5 grid grid-cols-4 gap-3">
    <div class="panel p-3">
      <div class="text-2xl font-bold text-fg-strong">{catalog.total}</div>
      <div class="text-xs text-fg-subtle">requests</div>
      <div class="mono mt-2 flex flex-wrap gap-1 text-xs text-fg-muted">
        {#each Object.entries(catalog.byMethod) as [m, n] (m)}
          <span class="rounded bg-[var(--color-bg-2)] px-1">{m} {n}</span>
        {/each}
      </div>
    </div>
    <div class="panel p-3">
      <div class="text-2xl font-bold text-fg-strong">{catalog.withAuth}</div>
      <div class="text-xs text-fg-subtle">with auth</div>
    </div>
    <div class="panel p-3">
      <div class="text-2xl font-bold text-fg-strong">{catalog.withScripts}</div>
      <div class="text-xs text-fg-subtle">with scripts</div>
    </div>
    <div class="panel p-3">
      <div class="text-2xl font-bold text-fg-strong">{catalog.envs}</div>
      <div class="text-xs text-fg-subtle">environments</div>
    </div>
  </div>

  <!-- Tests aggregate -->
  <div class="panel mb-5 flex gap-4 p-3 text-sm">
    <span class="text-fg-muted">{totals.runs} runs recorded</span>
    <span class="text-emerald-400">{totals.passed} tests passed</span>
    <span class={totals.failed ? "text-red-400" : "text-fg-subtle"}>{totals.failed} failed</span>
  </div>

  {#if networkRows.length}
    <h2 class="label mb-2">
      Network identity performance
    </h2>
    <div class="mb-5 overflow-hidden rounded border border-border">
      <table class="w-full text-sm">
        <thead class="bg-[var(--color-bg-1)] text-left text-xs text-fg-subtle">
          <tr class="border-b border-border">
            <th class="py-1.5 pr-3 pl-2 font-medium">Profile</th>
            <th class="py-1.5 pr-3 font-medium">Route</th>
            <th class="py-1.5 pr-3 font-medium">Dispatcher</th>
            <th class="py-1.5 pr-3 font-medium">Runs</th>
            <th class="py-1.5 pr-3 font-medium">Errors</th>
            <th class="py-1.5 pr-2 font-medium">Avg</th>
          </tr>
        </thead>
        <tbody>
          {#each networkRows.slice(0, 8) as row (row.key)}
            <tr class="border-b border-[var(--color-bg-2)] last:border-b-0">
              <td class="py-1.5 pr-3 pl-2 text-fg">{row.profile}</td>
              <td class="py-1.5 pr-3">
                <div class="text-fg">{row.proxy}</div>
                {#if row.proxyUrl && row.proxyUrl !== row.proxy}
                  <div class="mono max-w-72 truncate text-xs text-fg-faint" title={row.proxyUrl}>
                    {row.proxyUrl}
                  </div>
                {/if}
              </td>
              <td class="py-1.5 pr-3">
                <div class="mono text-xs text-fg-muted">{row.dispatcher}</div>
                {#if row.dispatcherClientId && row.dispatcherClientId !== row.dispatcher}
                  <div class="mono text-[10px] text-fg-faint" title={row.dispatcherClientId}>
                    {row.dispatcherClientId}
                  </div>
                {/if}
              </td>
              <td class="py-1.5 pr-3 text-fg">{row.runs} run{row.runs === 1 ? "" : "s"}</td>
              <td class="py-1.5 pr-3 {row.errors ? 'text-red-400' : 'text-emerald-400'}">
                {row.errorRate}% errors
              </td>
              <td class="py-1.5 pr-2">
                <div class="mono text-fg-muted">{row.avgMs}ms</div>
                {#if row.avgProxyMs !== undefined && row.avgOriginMs !== undefined}
                  <div class="mono text-[10px] text-fg-faint">
                    proxy {row.avgProxyMs}ms · origin {row.avgOriginMs}ms
                  </div>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <!-- Per-request history + latency -->
  <h2 class="label mb-2">
    History &amp; latency
  </h2>
  <table class="w-full text-sm">
    <thead class="text-left text-xs text-fg-subtle">
      <tr class="border-b border-border">
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
            <span class="mono text-xs text-fg-subtle">{p.req.method}</span>
            <span class="text-fg">{p.req.name}</span>
          </td>
          <td class="py-1.5 pr-3 text-fg">{p.runs}</td>
          <td class="py-1.5 pr-3 {p.okRate === 100 ? 'text-emerald-400' : p.okRate === null ? 'text-fg-faint' : 'text-amber-400'}">
            {p.okRate === null ? "—" : `${p.okRate}%`}
          </td>
          <td class="mono py-1.5 pr-3 text-fg-muted">{p.runs ? `${p.avgMs}ms` : "—"}</td>
          <td class="mono py-1.5 pr-3 {p.last ? statusColor(p.last.status) : 'text-fg-faint'}">
            {p.last ? p.last.status : "—"}
          </td>
          <td class="py-1.5">
            {#if p.durations.length > 1}
              <svg width="90" height="22" class="overflow-visible">
                <polyline
                  points={sparkline(p.durations)}
                  fill="none"
                  stroke="var(--color-brand)"
                  stroke-width="1.5"
                />
              </svg>
            {:else}
              <span class="text-xs text-fg-faint">—</span>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if perReq.every((p) => p.runs === 0)}
    <p class="hint mt-3">No runs yet — send some requests to populate the dashboard.</p>
  {/if}
</section>
