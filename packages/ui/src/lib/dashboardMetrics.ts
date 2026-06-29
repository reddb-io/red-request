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
  lastTs: number;
};

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
        lastTs: 0,
      } satisfies Acc);

    row.runs += 1;
    row.errors += h.ok ? 0 : 1;
    row.totalMs += h.durationMs;
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
      lastTs: row.lastTs,
    }))
    .sort((a, b) => b.lastTs - a.lastTs);
}
