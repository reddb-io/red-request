<script lang="ts">
  import { onMount } from "svelte";
  import { ws } from "../store.svelte";
  import * as repo from "../repo";
  import type { HistoryEntry } from "@reddb-io/request-core";
  import { networkIdentityRows } from "../dashboardMetrics";
  import { Button } from "./ui/button/index.js";

  let history = $state<HistoryEntry[]>([]);
  let nativeMetrics = $state<repo.NativeMetricDescriptor[]>([]);
  let nativeSources = $state<repo.NativeAnalyticsSource[]>([]);
  let loading = $state(true);

  async function load() {
    loading = true;
    [history, nativeMetrics, nativeSources] = await Promise.all([
      repo.loadHistory(ws.activeColId ?? undefined).catch(() => []),
      repo.nativeMetricDescriptors().catch(() => []),
      repo.nativeAnalyticsSources().catch(() => []),
    ]);
    loading = false;
  }
  onMount(load);

  const col = $derived(ws.activeCollection);

  const catalog = $derived.by(() => {
    const reqs = col?.requests ?? [];
    const byMethod: Record<string, number> = {};
    for (const r of reqs) {
      const key = r.kind === "http" ? r.method : r.kind.toUpperCase();
      byMethod[key] = (byMethod[key] ?? 0) + 1;
    }
    return {
      total: reqs.length,
      byMethod,
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

  const networkRows = $derived(networkIdentityRows(history));

  type ChartBar = { label: string; value: number; tone?: string };
  type NativeMetricChart = {
    path: string;
    title: string;
    kind: string;
    source: string | null;
    value: number;
    bars: ChartBar[];
    emptyLabel: string;
  };
  const methodBars = $derived.by<ChartBar[]>(() =>
    Object.entries(catalog.byMethod)
      .map(([label, value]) => ({ label, value, tone: "brand" }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
  );
  const runOutcomeBars = $derived.by<ChartBar[]>(() => {
    const ok = history.filter((h) => h.ok).length;
    const failed = history.length - ok;
    return [
      { label: "OK", value: ok, tone: "ok" },
      { label: "Error", value: failed, tone: "error" },
    ].filter((bar) => bar.value > 0 || history.length === 0);
  });
  const nativeMetricRows = $derived(
    nativeMetrics.filter((metric) => metric.path.startsWith("rr."))
  );
  const nativeSourceRows = $derived(
    nativeSources.filter((source) => source.name.startsWith("rr_"))
  );
  const nativeMetricCharts = $derived.by<NativeMetricChart[]>(() =>
    nativeMetricRows.map((metric) => nativeChart(metric))
  );

  function barWidth(value: number, values: ChartBar[]): number {
    if (value <= 0) return 0;
    const max = Math.max(...values.map((bar) => bar.value), 1);
    return Math.max(4, Math.round((value / max) * 100));
  }

  function barColor(tone: string | undefined): string {
    if (tone === "ok") return "bg-emerald-400";
    if (tone === "error") return "bg-red-400";
    return "bg-[var(--color-brand)]";
  }

  function nativeChart(metric: repo.NativeMetricDescriptor): NativeMetricChart {
    if (metric.path === "rr.requests.total") {
      return {
        path: metric.path,
        title: "Requests total",
        kind: metric.kind,
        source: metric.source,
        value: catalog.total,
        bars: [{ label: "requests", value: catalog.total, tone: "brand" }],
        emptyLabel: "No requests",
      };
    }
    if (metric.path === "rr.requests.by_method") {
      return {
        path: metric.path,
        title: "Requests by method",
        kind: metric.kind,
        source: metric.source,
        value: catalog.total,
        bars: methodBars,
        emptyLabel: "No requests",
      };
    }
    if (metric.path === "rr.history.runs") {
      return {
        path: metric.path,
        title: "Run outcomes",
        kind: metric.kind,
        source: metric.source,
        value: history.length,
        bars: runOutcomeBars,
        emptyLabel: "No runs",
      };
    }
    if (metric.path === "rr.environments.total") {
      return {
        path: metric.path,
        title: "Environments total",
        kind: metric.kind,
        source: metric.source,
        value: catalog.envs,
        bars: [{ label: "envs", value: catalog.envs, tone: "brand" }],
        emptyLabel: "No environments",
      };
    }
    return {
      path: metric.path,
      title: metric.path,
      kind: metric.kind,
      source: metric.source,
      value: 0,
      bars: [],
      emptyLabel: "No chart adapter",
    };
  }

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

{#snippet nativeMetricCard(chart: NativeMetricChart)}
  <section class="panel flex min-h-36 flex-col p-3" data-slot="dashboard-native-metric-chart">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h3 class="text-xs font-medium text-fg-subtle">{chart.title}</h3>
        <div class="mono mt-1 truncate text-[10px] text-fg-faint" title={chart.path}>
          {chart.path}
        </div>
      </div>
      <span class="mono text-lg font-semibold text-fg-strong">{chart.value}</span>
    </div>
    <div class="mt-2 flex items-center gap-2 text-[10px] text-fg-faint">
      <span>{chart.kind}</span>
      {#if chart.source}
        <span class="min-w-0 truncate" title={chart.source}>{chart.source}</span>
      {/if}
    </div>
    {#if chart.bars.length}
      <div class="mt-4 flex flex-1 flex-col justify-end gap-2">
        {#each chart.bars as bar (bar.label)}
          <div class="grid grid-cols-[5rem_1fr_2.5rem] items-center gap-2 text-xs">
            <span class="mono truncate text-fg-muted" title={bar.label}>{bar.label}</span>
            <div class="h-2 overflow-hidden rounded bg-[var(--color-bg-2)]">
              <div
                class="h-full rounded {barColor(bar.tone)}"
                style={`width:${barWidth(bar.value, chart.bars)}%`}
              ></div>
            </div>
            <span class="mono text-right text-fg">{bar.value}</span>
          </div>
        {/each}
      </div>
    {:else}
      <p class="mt-4 text-xs text-fg-faint">{chart.emptyLabel}</p>
    {/if}
  </section>
{/snippet}

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

  <h2 class="label mb-2">Native metrics</h2>
  {#if nativeSourceRows.length}
    <div class="mono mb-2 flex flex-wrap gap-2 text-[10px] text-fg-faint">
      {#each nativeSourceRows as source (source.name)}
        <span title={`${source.collection} ${source.timeField}/${source.eventField}/${source.actorField}`}>
          {source.name}
        </span>
      {/each}
    </div>
  {/if}
  {#if nativeMetricCharts.length}
    <div class="mb-5 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      {#each nativeMetricCharts as chart (chart.path)}
        {@render nativeMetricCard(chart)}
      {/each}
    </div>
  {:else}
    <p class="hint mb-5">No RedDB metric descriptors yet.</p>
  {/if}

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
