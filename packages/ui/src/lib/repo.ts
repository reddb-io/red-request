// Collection repository — backed by the embedded RedDB store (KV collections).
//
//   rr_collections   key=<colId>            → CollectionFile
//   rr_requests      key=<colId>.<reqId>    → RequestDefinition
//   rr_environments  key=<envSlug>          → StoredEnvironment (project-level, sealed secrets)
//   rr_settings      key="globals"          → Record<string,string> (project-level base vars)
//
// Keys use `.` as separator; collection/request ids and env slugs are URL-safe slugs.
// Environments and global vars are project-level (shared by every collection); a one-time
// migration in loadEnvironments() collapses any legacy per-collection `<colId>.<slug>` keys.
import {
  collectionFileSchema,
  requestDefinitionSchema,
  storedEnvironmentSchema,
  historyEntrySchema,
  networkSettingsSchema,
  newRequest,
  type CollectionFile,
  type RequestDefinition,
  type StoredEnvironment,
  type LoadedCollection,
  type HistoryEntry,
  type NetworkSettings,
} from "@red-request/core";
import * as db from "./reddb";
import { MIGRATIONS } from "./migrations";

/** Register + apply any pending RedDB-native migrations. Run on every project boot. */
export const runMigrations = () => db.runMigrations(MIGRATIONS);
/** Applied/pending/failed migration counts for the Settings → Data summary. */
export const migrationSummary = () => db.migrationSummary();

export const COL = "rr_collections";
export const REQ = "rr_requests";
export const ENV = "rr_environments";
export const HIST = "rr_history";
export const SETTINGS = "rr_settings";
export const OAUTH = "rr_oauth_tokens";

const MAX_HISTORY_PER_REQ = 50;

/** Cached OAuth2/OIDC token set, keyed by a connection id (hash of tokenUrl|clientId|
 *  scope|grantType). Token strings are sealed (AES-GCM) before they land here; the
 *  metadata (expiry/scope) stays in clear so the UI can show status without unsealing. */
export interface StoredOauthToken {
  accessSealed: { iv: string; ct: string };
  refreshSealed?: { iv: string; ct: string };
  idSealed?: { iv: string; ct: string };
  expiresAt: number; // epoch ms (0 = unknown/never)
  scope?: string;
  tokenType: string;
  obtainedAt: number;
}

/** Record counts per KV collection + total — for the Settings → Data store summary. */
export async function recordCounts(): Promise<{
  total: number;
  byKind: { label: string; count: number }[];
}> {
  const kinds: { label: string; name: string }[] = [
    { label: "collections", name: COL },
    { label: "requests", name: REQ },
    { label: "environments", name: ENV },
    { label: "history", name: HIST },
    { label: "settings", name: SETTINGS },
    { label: "oauth tokens", name: OAUTH },
  ];
  const counts = await Promise.all(kinds.map((k) => db.kvCount(k.name)));
  const byKind = kinds.map((k, i) => ({ label: k.label, count: counts[i]! }));
  return { total: counts.reduce((s, n) => s + n, 0), byKind };
}

export const loadOauthToken = (connId: string) =>
  db.kvGet<StoredOauthToken>(OAUTH, connId).catch(() => null);
export const saveOauthToken = (connId: string, token: StoredOauthToken) =>
  db.kvPut(OAUTH, connId, token);
export const deleteOauthToken = (connId: string) =>
  db.kvDelete(OAUTH, connId).catch(() => {});

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "item"
  );
}

const reqKey = (colId: string, reqId: string) => `${colId}.${reqId}`;
const ownedBy = (colId: string, key: string) => key.startsWith(`${colId}.`);

export async function ensureStore(): Promise<void> {
  await db.ensureKvCollection(COL);
  await db.ensureKvCollection(REQ);
  await db.ensureKvCollection(ENV);
  await db.ensureKvCollection(HIST);
  await db.ensureKvCollection(SETTINGS);
  await db.ensureKvCollection(OAUTH);
}

const NETWORK_KEY = "network";
/** Project-level network settings (proxy + profile pool), shared by all collections. */
export async function loadNetwork(): Promise<NetworkSettings> {
  const raw = await db.kvGet<unknown>(SETTINGS, NETWORK_KEY).catch(() => null);
  return networkSettingsSchema.parse(raw ?? {});
}
export const saveNetwork = (settings: NetworkSettings) =>
  db.kvPut(SETTINGS, NETWORK_KEY, settings);

/** Append a run to history and prune to the last MAX_HISTORY_PER_REQ for that request. */
export async function saveHistory(entry: HistoryEntry): Promise<void> {
  await db.kvPut(HIST, entry.id, entry);
  const all = await db.kvList<HistoryEntry>(HIST);
  const mine = all
    .map((e) => e.value)
    .filter((e) => e.reqId === entry.reqId)
    .sort((a, b) => b.ts - a.ts);
  for (const old of mine.slice(MAX_HISTORY_PER_REQ)) {
    await db.kvDelete(HIST, old.id);
  }
}

/** All history entries, newest first (optionally scoped to a collection). */
export async function loadHistory(colId?: string): Promise<HistoryEntry[]> {
  const all = await db.kvList<HistoryEntry>(HIST);
  return all
    .map((e) => historyEntrySchema.parse(e.value))
    .filter((e) => !colId || e.collectionId === colId)
    .sort((a, b) => b.ts - a.ts);
}

export async function loadAll(): Promise<LoadedCollection[]> {
  const [cols, reqs] = await Promise.all([
    db.kvList<CollectionFile>(COL),
    db.kvList<RequestDefinition>(REQ),
  ]);

  return cols.map(({ key: colId, value }) => {
    const collection = collectionFileSchema.parse(value);
    const requests = reqs
      .filter((r) => ownedBy(colId, r.key))
      .map((r) => requestDefinitionSchema.parse(r.value))
      .sort((a, b) => {
        const ia = collection.order.indexOf(a.id);
        const ib = collection.order.indexOf(b.id);
        return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
      });
    // Environments are project-level now (loaded via loadEnvironments).
    return { id: colId, collection, requests, environments: [] };
  });
}

/** Load the project-level environments. Self-migrates any legacy per-collection
 *  keys (`<colId>.<slug>`) to project keys (`<slug>`), deduping by name. */
export async function loadEnvironments(): Promise<StoredEnvironment[]> {
  const all = await db.kvList<StoredEnvironment>(ENV);
  const legacy = all.filter((e) => e.key.includes("."));
  if (legacy.length > 0) {
    const byName = new Map<string, StoredEnvironment>();
    for (const e of all) {
      const env = storedEnvironmentSchema.parse(e.value);
      byName.set(env.name, env); // later collections win on a name clash
    }
    for (const e of legacy) await db.kvDelete(ENV, e.key);
    for (const env of byName.values())
      await db.kvPut(ENV, slugify(env.name), env);
    return [...byName.values()];
  }
  return all.map((e) => storedEnvironmentSchema.parse(e.value));
}

const GLOBALS_KEY = "globals";
/** Project-level base variables (formerly per-collection `vars`). Null = never set. */
export async function loadGlobals(): Promise<Record<string, string> | null> {
  const raw = await db
    .kvGet<Record<string, string>>(SETTINGS, GLOBALS_KEY)
    .catch(() => null);
  return raw ?? null;
}
export const saveGlobals = (vars: Record<string, string>) =>
  db.kvPut(SETTINGS, GLOBALS_KEY, vars);

export const saveCollectionMeta = (colId: string, c: CollectionFile) =>
  db.kvPut(COL, colId, c);

export const saveRequest = (colId: string, req: RequestDefinition) =>
  db.kvPut(REQ, reqKey(colId, req.id), req);

export const deleteRequest = (colId: string, reqId: string) =>
  db.kvDelete(REQ, reqKey(colId, reqId));

export const saveEnvironment = (env: StoredEnvironment) =>
  db.kvPut(ENV, slugify(env.name), env);

export const deleteEnvironment = (name: string) =>
  db.kvDelete(ENV, slugify(name));

/** Delete a whole collection: its meta + every owned request and history row.
 *  Environments are project-level now, so they are not touched. */
export async function deleteCollection(colId: string): Promise<void> {
  const [reqs, hist] = await Promise.all([
    db.kvList<RequestDefinition>(REQ),
    db.kvList<HistoryEntry>(HIST),
  ]);
  await Promise.all([
    ...reqs
      .filter((r) => ownedBy(colId, r.key))
      .map((r) => db.kvDelete(REQ, r.key)),
    ...hist
      .filter((h) => h.value.collectionId === colId)
      .map((h) => db.kvDelete(HIST, h.key)),
  ]);
  await db.kvDelete(COL, colId);
}

/** Seed a runnable example collection the first time the store is empty. */
export async function ensureSample(): Promise<void> {
  const existing = await db.kvList<CollectionFile>(COL);
  if (existing.length > 0) return;

  const colId = "sample-httpbingo";
  await saveCollectionMeta(
    colId,
    collectionFileSchema.parse({
      name: "Sample · httpbingo",
      description: "A starter collection you can run immediately.",
      baseUrl: "https://httpbingo.org",
      vars: { host: "httpbingo.org" },
      auth: { type: "none" },
      order: ["get-anything", "post-json"],
    })
  );
  await saveRequest(colId, {
    ...newRequest("get-anything"),
    name: "GET anything",
    method: "GET",
    url: "https://{{host}}/get",
    query: [{ name: "hello", value: "world", enabled: true }],
  });
  await saveRequest(colId, {
    ...newRequest("post-json"),
    name: "POST json",
    method: "POST",
    url: "https://{{host}}/post",
    headers: [{ name: "X-Demo", value: "red-request", enabled: true }],
    body: { type: "json", content: '{\n  "name": "ada"\n}', fields: [] },
  });
  // a couple of non-HTTP kinds for discovery
  await saveRequest(colId, {
    ...newRequest("dns-a"),
    name: "DNS · {{host}}",
    kind: "dns",
    net: { ...newRequest("dns-a").net, host: "{{host}}", recordType: "A" },
  });
  await saveRequest(colId, {
    ...newRequest("ping-host"),
    name: "Ping · {{host}}",
    kind: "ping",
    net: {
      ...newRequest("ping-host").net,
      host: "{{host}}",
      port: 443,
      count: 4,
    },
  });
  await saveEnvironment(
    storedEnvironmentSchema.parse({
      name: "dev",
      vars: { host: "httpbingo.org" },
      secrets: {},
    })
  );
}
