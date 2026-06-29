import type { HistoryEntry } from "@reddb-io/request-core";

export type NetworkIdentityRow = {
  key: string;
  profile: string;
  proxy: string;
  proxyUrl?: string;
  dispatcher: string;
  dispatcherClientId?: string;
  dispatcherHost?: string;
  dispatcherUser?: string;
  runs: number;
  errors: number;
  errorRate: number;
  okRate: number;
  avgMs: number;
  avgProxyMs?: number;
  avgOriginMs?: number;
  proxyMeasuredRuns: number;
  lastTs: number;
};

type Acc = {
  key: string;
  profile: string;
  proxy: string;
  proxyUrl?: string;
  dispatcher: string;
  dispatcherClientId?: string;
  dispatcherHost?: string;
  dispatcherUser?: string;
  runs: number;
  errors: number;
  totalMs: number;
  totalProxyMs: number;
  totalOriginMs: number;
  proxyMeasuredRuns: number;
  lastTs: number;
};

type Timings = NonNullable<HistoryEntry["timings"]>;

const TIMING_ORDER = [
  "queuing",
  "proxyConnect",
  "proxyTls",
  "dns",
  "tcp",
  "tls",
  "originConnect",
  "firstByte",
  "content",
  "total",
] as const satisfies readonly (keyof Timings)[];

function idLabel(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function dispatcherLabel(h: HistoryEntry): string {
  const user = h.dispatcherUser?.trim();
  const host = h.dispatcherHost?.trim();
  if (user && host) return `${user}@${host}`;
  return user || host || idLabel(h.dispatcherClientId, "Local dispatcher");
}

function measuredPhaseMs(t: Timings | undefined, key: keyof Timings): number {
  if (!t || typeof t[key] !== "number") return 0;
  let previous = 0;
  for (const candidate of TIMING_ORDER) {
    if (candidate === key) break;
    const value = t[candidate];
    if (typeof value === "number") previous = Math.max(previous, value);
  }
  return Math.max(0, t[key] - previous);
}

function proxyRouteMs(t: Timings | undefined): number | undefined {
  if (typeof t?.proxyConnect !== "number" && typeof t?.proxyTls !== "number") {
    return undefined;
  }
  return measuredPhaseMs(t, "proxyConnect") + measuredPhaseMs(t, "proxyTls");
}

export function networkIdentityRows(
  history: HistoryEntry[]
): NetworkIdentityRow[] {
  const groups = new Map<string, Acc>();
  for (const h of history) {
    const profileKey = h.profileId || h.profileName || "direct-profile";
    const proxyKey = h.proxyId || h.proxyUrl || "direct-route";
    const dispatcherHost = h.dispatcherHost?.trim() || undefined;
    const dispatcherUser = h.dispatcherUser?.trim() || undefined;
    const dispatcherClientId = h.dispatcherClientId?.trim() || undefined;
    const dispatcherKey =
      [dispatcherHost, dispatcherUser, dispatcherClientId]
        .filter(Boolean)
        .join("|") || "local-dispatcher";
    const key = `${profileKey}|${proxyKey}|${dispatcherKey}`;
    const row =
      groups.get(key) ??
      ({
        key,
        profile: idLabel(h.profileName ?? h.profileId, "No profile"),
        proxy: idLabel(h.proxyName ?? h.proxyUrl, "Direct"),
        proxyUrl: h.proxyUrl,
        dispatcher: dispatcherLabel(h),
        dispatcherClientId,
        dispatcherHost,
        dispatcherUser,
        runs: 0,
        errors: 0,
        totalMs: 0,
        totalProxyMs: 0,
        totalOriginMs: 0,
        proxyMeasuredRuns: 0,
        lastTs: 0,
      } satisfies Acc);

    row.runs += 1;
    row.errors += h.ok ? 0 : 1;
    row.totalMs += h.durationMs;
    const proxyMs = proxyRouteMs(h.timings);
    if (proxyMs !== undefined) {
      const totalMs = h.timings?.total ?? h.durationMs;
      row.totalProxyMs += proxyMs;
      row.totalOriginMs += Math.max(0, totalMs - proxyMs);
      row.proxyMeasuredRuns += 1;
    }
    row.lastTs = Math.max(row.lastTs, h.ts);
    groups.set(key, row);
  }

  return [...groups.values()]
    .map((row) => ({
      key: row.key,
      profile: row.profile,
      proxy: row.proxy,
      proxyUrl: row.proxyUrl,
      dispatcher: row.dispatcher,
      dispatcherClientId: row.dispatcherClientId,
      dispatcherHost: row.dispatcherHost,
      dispatcherUser: row.dispatcherUser,
      runs: row.runs,
      errors: row.errors,
      errorRate: Math.round((row.errors / row.runs) * 100),
      okRate: Math.round(((row.runs - row.errors) / row.runs) * 100),
      avgMs: Math.round(row.totalMs / row.runs),
      avgProxyMs: row.proxyMeasuredRuns
        ? Math.round(row.totalProxyMs / row.proxyMeasuredRuns)
        : undefined,
      avgOriginMs: row.proxyMeasuredRuns
        ? Math.round(row.totalOriginMs / row.proxyMeasuredRuns)
        : undefined,
      proxyMeasuredRuns: row.proxyMeasuredRuns,
      lastTs: row.lastTs,
    }))
    .sort((a, b) => b.lastTs - a.lastTs);
}
