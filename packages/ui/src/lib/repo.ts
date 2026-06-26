// Collection repository — backed by the embedded RedDB store.
//
//   rr_collections    KV key=<colId>         → CollectionFile
//   rr_requests       Document app_key=<colId>.<reqId> → RequestDefinition envelope
//   rr_environments   KV key=<envSlug>       → StoredEnvironment (project-level, sealed secrets)
//   rr_settings       KV key="globals"       → Record<string,string> (project-level base vars)
//
// Keys use `.` as separator; collection/request ids and env slugs are URL-safe slugs.
// Environments and global vars are project-level (shared by every collection); a one-time
// migration in loadEnvironments() collapses any legacy per-collection `<colId>.<slug>` keys.
import {
  collectionFileSchema,
  requestDefinitionSchema,
  storedEnvironmentSchema,
  historyEntrySchema,
  migrateLegacyDynamicTokens,
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
import { appLog } from "./log";

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

type RequestDocumentBody = {
  record_type: "request";
  app_key: string;
  collection_id: string;
  request_id: string;
  request_name: string;
  request_kind: RequestDefinition["kind"];
  request: RequestDefinition;
};

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
    { label: "environments", name: ENV },
    { label: "history", name: HIST },
    { label: "settings", name: SETTINGS },
    { label: "oauth tokens", name: OAUTH },
  ];
  const [kvCounts, requestCount] = await Promise.all([
    Promise.all(kinds.map((k) => db.kvCount(k.name))),
    countRequests(),
  ]);
  const kvByLabel = new Map(kinds.map((k, i) => [k.label, kvCounts[i] ?? 0]));
  const byKind = [
    { label: "collections", count: kvByLabel.get("collections") ?? 0 },
    { label: "requests", count: requestCount },
    { label: "environments", count: kvByLabel.get("environments") ?? 0 },
    { label: "history", count: kvByLabel.get("history") ?? 0 },
    { label: "settings", count: kvByLabel.get("settings") ?? 0 },
    { label: "oauth tokens", count: kvByLabel.get("oauth tokens") ?? 0 },
  ];
  return { total: requestCount + kvCounts.reduce((s, n) => s + n, 0), byKind };
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

function colIdFromReqKey(key: string): string | null {
  const sep = key.indexOf(".");
  return sep > 0 ? key.slice(0, sep) : null;
}

function requestDocumentBody(
  colId: string,
  req: RequestDefinition
): RequestDocumentBody {
  const parsed = requestDefinitionSchema.parse(req);
  return {
    record_type: "request",
    app_key: reqKey(colId, parsed.id),
    collection_id: colId,
    request_id: parsed.id,
    request_name: parsed.name,
    request_kind: parsed.kind,
    request: parsed,
  };
}

function parseRequestDocumentBody(value: unknown): RequestDocumentBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const raw = value as Partial<RequestDocumentBody>;
  if (
    raw.record_type !== "request" ||
    typeof raw.app_key !== "string" ||
    typeof raw.collection_id !== "string" ||
    typeof raw.request_id !== "string" ||
    typeof raw.request !== "object" ||
    raw.request === null
  )
    return null;
  let request: RequestDefinition;
  try {
    request = requestDefinitionSchema.parse(raw.request);
  } catch {
    return null;
  }
  return {
    record_type: "request",
    app_key: raw.app_key,
    collection_id: raw.collection_id,
    request_id: raw.request_id,
    request_name:
      typeof raw.request_name === "string" ? raw.request_name : request.name,
    request_kind:
      raw.request_kind === request.kind ? raw.request_kind : request.kind,
    request,
  };
}

function requestFromDocument(
  doc: db.DocumentRecord<RequestDocumentBody>
): { key: string; value: RequestDefinition } | null {
  const body = parseRequestDocumentBody(doc.body);
  return body ? { key: body.app_key, value: body.request } : null;
}

async function listRequestDocuments(): Promise<
  Array<{ key: string; value: RequestDefinition; rid: string }>
> {
  const docs = await db.documentList<RequestDocumentBody>(REQ);
  const out: Array<{ key: string; value: RequestDefinition; rid: string }> = [];
  for (const doc of docs) {
    const parsed = requestFromDocument(doc);
    if (parsed) out.push({ ...parsed, rid: doc.rid });
  }
  return out;
}

async function countRequests(): Promise<number> {
  const keys = new Set<string>();
  for (const doc of await listRequestDocuments().catch(() => []))
    keys.add(doc.key);
  return keys.size;
}

async function insertMissingRequestDocuments(
  entries: Array<{ key: string; value: RequestDefinition }>
): Promise<void> {
  const docs = await listRequestDocuments().catch(() => []);
  const have = new Set(docs.map((doc) => doc.key));
  for (const { key, value } of entries) {
    if (have.has(key)) continue;
    const colId = colIdFromReqKey(key);
    if (!colId) continue;
    await db.documentInsert(REQ, requestDocumentBody(colId, value));
    have.add(key);
  }
}

async function ensureRequestCollection(): Promise<void> {
  const model = await db.collectionModel(REQ);
  if (model === "document") {
    await db.ensureDocumentCollection(REQ);
    return;
  }

  const legacy = model
    ? await db.kvList<RequestDefinition>(REQ).catch(() => [])
    : [];
  if (model) await db.dropCollection(REQ);
  await db.ensureDocumentCollection(REQ);
  await insertMissingRequestDocuments(legacy);
}

export async function importLegacyRequestEntries(
  entries: Array<{ key: string; value: RequestDefinition }>
): Promise<void> {
  const model = await db.collectionModel(REQ);
  if (model && model !== "document") await db.dropCollection(REQ);
  await db.ensureDocumentCollection(REQ);
  await insertMissingRequestDocuments(entries);
}

export function legacyRequestEntry(
  key: string,
  value: unknown
): { key: string; value: RequestDefinition } | null {
  const colId = colIdFromReqKey(key);
  if (!colId) return null;
  try {
    return { key, value: requestDefinitionSchema.parse(value) };
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function appendPatchOperations(
  before: unknown,
  after: unknown,
  path: string,
  out: db.DocumentPatchOperation[]
): void {
  if (sameJson(before, after)) return;
  if (!isPlainRecord(before) || !isPlainRecord(after)) {
    out.push({ op: "set", path, value: after });
    return;
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const nextPath = `${path}/${pointerSegment(key)}`;
    if (!(key in after)) {
      out.push({ op: "unset", path: nextPath });
      continue;
    }
    if (!(key in before)) {
      out.push({ op: "set", path: nextPath, value: after[key] });
      continue;
    }
    appendPatchOperations(before[key], after[key], nextPath, out);
  }
}

function requestDocumentPatch(
  before: RequestDocumentBody,
  after: RequestDocumentBody
): db.DocumentPatchOperation[] {
  const out: db.DocumentPatchOperation[] = [];
  appendPatchOperations(before, after, "/body", out);
  return out;
}

async function saveRequestDocument(
  colId: string,
  req: RequestDefinition
): Promise<void> {
  const desired = requestDocumentBody(colId, req);
  const existing = await db.documentFindByField<RequestDocumentBody>(
    REQ,
    "app_key",
    desired.app_key
  );
  if (!existing) {
    await db.documentInsert(REQ, desired);
    return;
  }

  const current = parseRequestDocumentBody(existing.body);
  if (!current) {
    await db.documentReplace(REQ, existing.rid, desired);
    return;
  }

  await db.documentPatch(
    REQ,
    existing.rid,
    requestDocumentPatch(current, desired)
  );
}

async function requestDocumentAsOf(
  colId: string,
  reqId: string,
  commitHash: string
): Promise<RequestDefinition | null> {
  const doc = await db.documentFindByFieldAsOf<RequestDocumentBody>(
    REQ,
    "app_key",
    reqKey(colId, reqId),
    commitHash
  );
  return doc ? (parseRequestDocumentBody(doc.body)?.request ?? null) : null;
}

/** The data collections whose edits we version + time-travel (native VCS).
 *  HIST (response runs, pruned) and OAUTH (ephemeral tokens) stay last-writer-wins. */
export const VERSIONED_COLLECTIONS = [COL, REQ, ENV, SETTINGS] as const;

export async function ensureStore(): Promise<void> {
  await db.ensureKvCollection(COL);
  await db.ensureKvCollection(ENV);
  await db.ensureKvCollection(HIST);
  await db.ensureKvCollection(SETTINGS);
  await db.ensureKvCollection(OAUTH);
  await ensureRequestCollection();
  // Opt the document collections into MVCC versioning so commits time-travel.
  // Idempotent + best-effort: an older sidecar that lacks versioning just no-ops.
  for (const c of VERSIONED_COLLECTIONS) await db.setVersioned(c);
}

const NETWORK_KEY = "network";
/** Project-level network settings (proxy + profile pool), shared by all collections. */
export async function loadNetwork(): Promise<NetworkSettings> {
  const raw = await db.kvGet<unknown>(SETTINGS, NETWORK_KEY).catch(() => null);
  return networkSettingsSchema.parse(raw ?? {});
}
export const saveNetwork = async (settings: NetworkSettings) => {
  await db.kvPut(SETTINGS, NETWORK_KEY, settings);
  db.commitSoon("update network settings");
};

/** Append a run to history and prune to the last MAX_HISTORY_PER_REQ for that request. */
export async function saveHistory(entry: HistoryEntry): Promise<void> {
  await db.kvPut(HIST, entry.id, entry);
  const mine: HistoryEntry[] = [];
  for (const { value } of await db.kvList<HistoryEntry>(HIST)) {
    if (value.reqId === entry.reqId) mine.push(value);
  }
  mine.sort((a, b) => b.ts - a.ts);
  for (let i = MAX_HISTORY_PER_REQ; i < mine.length; i++) {
    const old = mine[i]!;
    await db.kvDelete(HIST, old.id);
  }
}

/** All history entries, newest first (optionally scoped to a collection). */
export async function loadHistory(colId?: string): Promise<HistoryEntry[]> {
  const out: HistoryEntry[] = [];
  for (const { value } of await db.kvList<HistoryEntry>(HIST)) {
    const entry = historyEntrySchema.parse(value);
    if (!colId || entry.collectionId === colId) out.push(entry);
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export async function loadAll(): Promise<LoadedCollection[]> {
  const [cols, docReqs] = await Promise.all([
    db.kvList<CollectionFile>(COL),
    listRequestDocuments().catch(() => []),
  ]);
  const reqs = new Map<string, RequestDefinition>();
  for (const req of docReqs) reqs.set(req.key, req.value);

  const reqsByCollection = new Map<
    string,
    Array<{ key: string; value: RequestDefinition }>
  >();
  for (const [key, value] of reqs) {
    const colId = colIdFromReqKey(key);
    if (!colId) continue;
    const req = { key, value };
    const bucket = reqsByCollection.get(colId);
    if (bucket) bucket.push(req);
    else reqsByCollection.set(colId, [req]);
  }

  return cols.map(({ key: colId, value }) => {
    const collection = collectionFileSchema.parse(value);
    const orderIndex = new Map(collection.order.map((id, i) => [id, i]));
    const requests = (reqsByCollection.get(colId) ?? [])
      .filter((r) => ownedBy(colId, r.key))
      .map((r) => requestDefinitionSchema.parse(r.value))
      .sort((a, b) => {
        const ia = orderIndex.get(a.id) ?? 1e9;
        const ib = orderIndex.get(b.id) ?? 1e9;
        return ia - ib;
      });
    // Environments are project-level now (loaded via loadEnvironments).
    const loaded = { id: colId, collection, requests, environments: [] };
    const migrated = migrateLegacyDynamicTokens(loaded);
    if (migrated.warnings.length > 0) {
      const rewritten = [
        ...new Set(
          migrated.warnings.map((w) => `${w.token} -> ${w.replacement}`)
        ),
      ].join(", ");
      appLog(
        "warn",
        `Deprecated dynamic tokens migrated in collection ${colId}: ${rewritten}`
      );
    }
    return migrated.value;
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
export const saveGlobals = async (vars: Record<string, string>) => {
  await db.kvPut(SETTINGS, GLOBALS_KEY, vars);
  db.commitSoon("update globals");
};

export const saveCollectionMeta = async (colId: string, c: CollectionFile) => {
  await db.kvPut(COL, colId, c);
  db.commitSoon(`save collection ${c.name ?? colId}`);
};

export const saveRequest = async (colId: string, req: RequestDefinition) => {
  await saveRequestDocument(colId, req);
  db.commitSoon(`save request ${req.name ?? req.id}`);
};

export const deleteRequest = async (colId: string, reqId: string) => {
  const doc = await db.documentFindByField<RequestDocumentBody>(
    REQ,
    "app_key",
    reqKey(colId, reqId)
  );
  if (doc) await db.documentDelete(REQ, doc.rid);
  db.commitSoon("delete request");
};

export const saveEnvironment = async (env: StoredEnvironment) => {
  await db.kvPut(ENV, slugify(env.name), env);
  db.commitSoon(`save environment ${env.name}`);
};

export const deleteEnvironment = async (name: string) => {
  await db.kvDelete(ENV, slugify(name));
  db.commitSoon(`delete environment ${name}`);
};

/** Delete a whole collection: its meta + every owned request and history row.
 *  Environments are project-level now, so they are not touched. */
export async function deleteCollection(colId: string): Promise<void> {
  const [docReqs, hist] = await Promise.all([
    listRequestDocuments().catch(() => []),
    db.kvList<HistoryEntry>(HIST),
  ]);
  await Promise.all([
    ...docReqs
      .filter((r) => ownedBy(colId, r.key))
      .map((r) => db.documentDelete(REQ, r.rid)),
    ...hist
      .filter((h) => h.value.collectionId === colId)
      .map((h) => db.kvDelete(HIST, h.key)),
  ]);
  await db.kvDelete(COL, colId);
  db.commitSoon("delete collection");
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

// --- Native VCS: request history / time-travel -----------------------------
// Commits are whole-store restore points (a commit pins the global MVCC snapshot);
// `requestAsOf` reads one request's value as it was at a given commit.
export type { VcsCommit } from "./reddb";

/** Recent store commits (restore points), newest first. */
export const listCommits = (limit = 50) => db.listCommits(limit);

/** A request's definition as it was at `commitHash`, or null if it didn't exist then. */
export async function requestAsOf(
  colId: string,
  reqId: string,
  commitHash: string
): Promise<RequestDefinition | null> {
  const docValue = await requestDocumentAsOf(colId, reqId, commitHash).catch(
    () => null
  );
  if (docValue) return docValue;
  return db
    .kvGetAsOf<RequestDefinition>(REQ, reqKey(colId, reqId), commitHash)
    .catch(() => null);
}

/** One node of a request's timeline: its value at a commit + whether it changed there. */
export interface RequestHistoryNode {
  commit: import("./reddb").VcsCommit;
  value: RequestDefinition | null;
  /** True when this commit is where an edit to THIS request landed (value differs from
   *  the next-older commit) — i.e. a real version boundary, vs a commit that touched
   *  other collections only. */
  changedHere: boolean;
}

/** Full timeline of a request across the store's commits (newest first). Resolves the
 *  request AS OF every commit and flags the commits where it actually changed. */
export async function requestHistory(
  colId: string,
  reqId: string,
  limit = 100
): Promise<RequestHistoryNode[]> {
  const commits = await db.listCommits(limit);
  const values = await Promise.all(
    commits.map((c) => requestAsOf(colId, reqId, c.hash).catch(() => null))
  );
  const json = values.map((v) => (v ? JSON.stringify(v) : null));
  return commits.map((commit, i) => ({
    commit,
    value: values[i],
    changedHere: json[i] !== (json[i + 1] ?? null),
  }));
}
