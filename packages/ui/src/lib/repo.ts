// Collection repository — backed by the embedded RedDB store.
//
//   rr_collections    KV key=<colId>         → CollectionFile
//   rr_requests       Document app_key=<colId>.<reqId> → RequestDefinition envelope
//   red_request       CONFIG env_<hex>       → StoredEnvironment (project-level vars + native secret refs)
//   red_request       CONFIG settings_*      → project-local app settings
//   red_request_secrets VAULT e_<hex>.s_<hex> → RedDB-native secret values
//   rr_environments   KV key=<envSlug>       → legacy migration source only
//   rr_settings       KV key=*               → legacy migration source only
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
  nativeSecretRefSchema,
  sealedSecretSchema,
  type CollectionFile,
  type RequestDefinition,
  type StoredEnvironment,
  type NativeSecretRef,
  type StoredSecret,
  type LoadedCollection,
  type HistoryEntry,
  type NetworkSettings,
} from "@red-request/core";
import * as db from "./reddb";
import * as secrets from "./secrets";
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
const REQ_MIGRATION_STAGE = "rr_requests_migration_stage";
// RedDB enforces one declared model per collection, so app CONFIG and VAULT
// data must live in separate collections.
const APP_CONFIG = "red_request";
const APP_VAULT = "red_request_secrets";
const ENV_CONFIG_PREFIX = "env_";
const SECRET_CONFIG_PREFIX = "secret_";
const SETTINGS_NETWORK_KEY = "settings_network";
const SETTINGS_UI_KEY = "settings_ui";
const SETTINGS_GLOBALS_KEY = "settings_globals";
const SETTINGS_ENV_ORDER_KEY = "settings_env_order";

type RequestDocumentBody = {
  record_type: "request";
  app_key: string;
  collection_id: string;
  request_id: string;
  request_name: string;
  request_kind: RequestDefinition["kind"];
  request_method: string;
  request_url: string;
  request_folder: string;
  request_target: string;
  search_text: string;
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
    { label: "history", name: HIST },
    { label: "oauth tokens", name: OAUTH },
  ];
  const [kvCounts, requestCount, envCount, settingsCount] = await Promise.all([
    Promise.all(kinds.map((k) => db.kvCount(k.name))),
    countRequests(),
    db.configList<unknown>(APP_CONFIG, ENV_CONFIG_PREFIX).then((r) => r.length),
    db.configList<unknown>(APP_CONFIG, "settings_").then((r) => r.length),
  ]);
  const kvByLabel = new Map(kinds.map((k, i) => [k.label, kvCounts[i] ?? 0]));
  const byKind = [
    { label: "collections", count: kvByLabel.get("collections") ?? 0 },
    { label: "requests", count: requestCount },
    { label: "environments", count: envCount },
    { label: "history", count: kvByLabel.get("history") ?? 0 },
    { label: "settings", count: settingsCount },
    { label: "oauth tokens", count: kvByLabel.get("oauth tokens") ?? 0 },
  ];
  return {
    total:
      requestCount +
      envCount +
      settingsCount +
      kvCounts.reduce((s, n) => s + n, 0),
    byKind,
  };
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

function hexUtf8(value: string): string {
  return Array.from(new TextEncoder().encode(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function nativeEnvKey(name: string): string {
  return `${ENV_CONFIG_PREFIX}${hexUtf8(name) || "00"}`;
}

function nativeSecretKey(name: string): string {
  return `s_${hexUtf8(name) || "00"}`;
}

function nativeSecretEnvSegment(envName: string): string {
  return `e_${hexUtf8(envName) || "00"}`;
}

function nativeSecretConfigKey(envName: string, secretName: string): string {
  return `${SECRET_CONFIG_PREFIX}${hexUtf8(envName) || "00"}_${
    hexUtf8(secretName) || "00"
  }`;
}

function nativeSecretPath(envName: string, secretName: string): string {
  return `${APP_VAULT}.${nativeSecretEnvSegment(envName)}.${nativeSecretKey(
    secretName
  )}`;
}

function nativeSecretRef(
  envName: string,
  secretName: string,
  missing = false
): NativeSecretRef {
  return nativeSecretRefSchema.parse({
    ref: nativeSecretPath(envName, secretName),
    vault: APP_VAULT,
    configKey: nativeSecretConfigKey(envName, secretName),
    missing,
  });
}

function isNativeSecret(secret: StoredSecret): secret is NativeSecretRef {
  return nativeSecretRefSchema.safeParse(secret).success;
}

function isSealedSecret(secret: StoredSecret): boolean {
  return sealedSecretSchema.safeParse(secret).success;
}

const reqKey = (colId: string, reqId: string) => `${colId}.${reqId}`;
const ownedBy = (colId: string, key: string) => key.startsWith(`${colId}.`);

function colIdFromReqKey(key: string): string | null {
  const sep = key.indexOf(".");
  return sep > 0 ? key.slice(0, sep) : null;
}

function requestTarget(req: RequestDefinition): string {
  if (req.kind === "grpc") {
    const method = [req.grpc.service, req.grpc.method]
      .filter(Boolean)
      .join("/");
    return [req.url, method].filter(Boolean).join(" ");
  }
  if (req.url) return req.url;
  if (!req.net.host) return "";
  return req.net.port ? `${req.net.host}:${req.net.port}` : req.net.host;
}

function requestSearchText(
  colId: string,
  req: RequestDefinition,
  target: string
): string {
  return [
    colId,
    req.id,
    req.name,
    req.folder,
    req.kind,
    req.method,
    req.url,
    target,
    req.net.host,
    req.net.port ? String(req.net.port) : "",
    req.net.recordType,
    req.grpc.service,
    req.grpc.method,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function requestDocumentBody(
  colId: string,
  req: RequestDefinition
): RequestDocumentBody {
  const parsed = requestDefinitionSchema.parse(req);
  const target = requestTarget(parsed);
  return {
    record_type: "request",
    app_key: reqKey(colId, parsed.id),
    collection_id: colId,
    request_id: parsed.id,
    request_name: parsed.name,
    request_kind: parsed.kind,
    request_method: parsed.kind === "http" ? parsed.method : "",
    request_url: parsed.url,
    request_folder: parsed.folder,
    request_target: target,
    search_text: requestSearchText(colId, parsed, target),
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
    request_method:
      typeof raw.request_method === "string"
        ? raw.request_method
        : request.kind === "http"
          ? request.method
          : "",
    request_url:
      typeof raw.request_url === "string" ? raw.request_url : request.url,
    request_folder:
      typeof raw.request_folder === "string"
        ? raw.request_folder
        : request.folder,
    request_target:
      typeof raw.request_target === "string"
        ? raw.request_target
        : requestTarget(request),
    search_text:
      typeof raw.search_text === "string"
        ? raw.search_text
        : requestSearchText(raw.collection_id, request, requestTarget(request)),
    request,
  };
}

function requestFromDocument(
  doc: db.DocumentRecord<RequestDocumentBody>
): { key: string; value: RequestDefinition } | null {
  const body = parseRequestDocumentBody(doc.body);
  return body ? { key: body.app_key, value: body.request } : null;
}

async function listRequestDocumentsFrom(
  collection: string
): Promise<Array<{ key: string; value: RequestDefinition; rid: string }>> {
  const docs = await db.documentList<RequestDocumentBody>(collection);
  const out: Array<{ key: string; value: RequestDefinition; rid: string }> = [];
  for (const doc of docs) {
    const parsed = requestFromDocument(doc);
    if (parsed) out.push({ ...parsed, rid: doc.rid });
  }
  return out;
}

async function listRequestDocuments(): Promise<
  Array<{ key: string; value: RequestDefinition; rid: string }>
> {
  return listRequestDocumentsFrom(REQ);
}

async function countRequests(): Promise<number> {
  const keys = new Set<string>();
  for (const doc of await listRequestDocuments().catch(() => []))
    keys.add(doc.key);
  return keys.size;
}

async function insertMissingRequestDocuments(
  collection: string,
  entries: Array<{ key: string; value: RequestDefinition }>
): Promise<void> {
  const docs = await listRequestDocumentsFrom(collection).catch(() => []);
  const have = new Set(docs.map((doc) => doc.key));
  for (const { key, value } of entries) {
    if (have.has(key)) continue;
    const colId = colIdFromReqKey(key);
    if (!colId) continue;
    await db.documentInsert(collection, requestDocumentBody(colId, value));
    have.add(key);
  }
}

function assertRequestEntriesPresent(
  collection: string,
  expected: Array<{ key: string; value: RequestDefinition }>,
  actual: Array<{ key: string; value: RequestDefinition }>
): void {
  const have = new Set(actual.map((doc) => doc.key));
  const missing = expected
    .map((entry) => entry.key)
    .filter((key) => !have.has(key));
  if (missing.length > 0)
    throw new Error(
      `request migration ${collection}: missing ${missing.length} staged request(s)`
    );
}

async function stagedRequestMigrationEntries(): Promise<
  Array<{ key: string; value: RequestDefinition; rid: string }>
> {
  const model = await db.collectionModel(REQ_MIGRATION_STAGE);
  if (model !== "document") return [];
  return listRequestDocumentsFrom(REQ_MIGRATION_STAGE).catch(() => []);
}

async function dropRequestMigrationStage(): Promise<void> {
  await db.dropCollection(REQ_MIGRATION_STAGE).catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    appLog("warn", `request migration stage cleanup failed: ${detail}`);
  });
}

async function stageLegacyRequestMigration(
  legacy: Array<{ key: string; value: RequestDefinition }>
): Promise<Array<{ key: string; value: RequestDefinition }>> {
  const stageModel = await db.collectionModel(REQ_MIGRATION_STAGE);
  if (stageModel) await db.dropCollection(REQ_MIGRATION_STAGE);
  await db.ensureDocumentCollection(REQ_MIGRATION_STAGE);
  await insertMissingRequestDocuments(REQ_MIGRATION_STAGE, legacy);
  const staged = await listRequestDocumentsFrom(REQ_MIGRATION_STAGE);
  assertRequestEntriesPresent(REQ_MIGRATION_STAGE, legacy, staged);
  return staged.map(({ key, value }) => ({ key, value }));
}

async function recoverStagedRequestMigration(): Promise<void> {
  const staged = await stagedRequestMigrationEntries();
  if (staged.length === 0) return;
  const entries = staged.map(({ key, value }) => ({ key, value }));
  await insertMissingRequestDocuments(REQ, entries);
  const canonical = await listRequestDocuments();
  assertRequestEntriesPresent(REQ, entries, canonical);
  await dropRequestMigrationStage();
}

async function ensureRequestCollection(): Promise<void> {
  const model = await db.collectionModel(REQ);
  if (model === "document") {
    await db.ensureDocumentCollection(REQ);
    await recoverStagedRequestMigration();
    await backfillRequestDocumentPromotedFieldsBestEffort();
    return;
  }

  if (!model) {
    const staged = await stagedRequestMigrationEntries();
    await db.ensureDocumentCollection(REQ);
    if (staged.length > 0) await recoverStagedRequestMigration();
    await backfillRequestDocumentPromotedFieldsBestEffort();
    return;
  }

  const legacy = model
    ? await db.kvList<RequestDefinition>(REQ).catch(() => [])
    : [];
  const staged = await stageLegacyRequestMigration(legacy);
  await db.dropCollection(REQ);
  await db.ensureDocumentCollection(REQ);
  await insertMissingRequestDocuments(REQ, staged);
  assertRequestEntriesPresent(REQ, staged, await listRequestDocuments());
  await dropRequestMigrationStage();
  await backfillRequestDocumentPromotedFieldsBestEffort();
}

export async function importLegacyRequestEntries(
  entries: Array<{ key: string; value: RequestDefinition }>
): Promise<void> {
  const model = await db.collectionModel(REQ);
  if (model && model !== "document") await db.dropCollection(REQ);
  await db.ensureDocumentCollection(REQ);
  await insertMissingRequestDocuments(REQ, entries);
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

const REQUEST_DOCUMENT_PROMOTED_FIELDS: Array<keyof RequestDocumentBody> = [
  "record_type",
  "app_key",
  "collection_id",
  "request_id",
  "request_name",
  "request_kind",
  "request_method",
  "request_url",
  "request_folder",
  "request_target",
  "search_text",
];

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
  after: RequestDocumentBody,
  rawBefore?: unknown
): db.DocumentPatchOperation[] {
  const out: db.DocumentPatchOperation[] = [];
  appendPatchOperations(before, after, "/body", out);
  appendPromotedRequestDocumentPatch(rawBefore, after, out);
  return out;
}

function appendPromotedRequestDocumentPatch(
  rawBefore: unknown,
  after: RequestDocumentBody,
  out: db.DocumentPatchOperation[]
): void {
  if (!isPlainRecord(rawBefore)) return;
  const seen = new Set(out.map((op) => op.path));
  for (const field of REQUEST_DOCUMENT_PROMOTED_FIELDS) {
    const path = `/body/${pointerSegment(field)}`;
    if (seen.has(path) || sameJson(rawBefore[field], after[field])) continue;
    out.push({ op: "set", path, value: after[field] });
    seen.add(path);
  }
}

async function backfillRequestDocumentPromotedFields(): Promise<void> {
  const docs = await db.documentList<RequestDocumentBody>(REQ).catch(() => []);
  for (const doc of docs) {
    const current = parseRequestDocumentBody(doc.body);
    if (!current) continue;
    const desired = requestDocumentBody(current.collection_id, current.request);
    const operations: db.DocumentPatchOperation[] = [];
    appendPromotedRequestDocumentPatch(doc.body, desired, operations);
    if (operations.length > 0) await db.documentPatch(REQ, doc.rid, operations);
  }
}

async function backfillRequestDocumentPromotedFieldsBestEffort(): Promise<void> {
  try {
    await backfillRequestDocumentPromotedFields();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    appLog("warn", `request search metadata backfill failed: ${detail}`);
  }
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
    requestDocumentPatch(current, desired, existing.body)
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
export const VERSIONED_COLLECTIONS = [COL, REQ] as const;

export async function ensureStore(): Promise<void> {
  await db.ensureKvCollection(COL);
  await db.ensureKvCollection(HIST);
  await db.ensureKvCollection(OAUTH);
  await ensureRequestCollection();
  await db.ensureVaultCollection(APP_VAULT);
  // Opt the document collections into MVCC versioning so commits time-travel.
  // Idempotent + best-effort: an older sidecar that lacks versioning just no-ops.
  for (const c of VERSIONED_COLLECTIONS) await db.setVersioned(c);
}

const NETWORK_KEY = "network";
/** Project-level network settings (proxy + profile pool), shared by all collections. */
export async function loadNetwork(): Promise<NetworkSettings> {
  const raw =
    (await db
      .configGet<unknown>(APP_CONFIG, SETTINGS_NETWORK_KEY)
      .catch(() => null)) ??
    (await db.kvGet<unknown>(SETTINGS, NETWORK_KEY).catch(() => null));
  return networkSettingsSchema.parse(raw ?? {});
}
export const saveNetwork = async (settings: NetworkSettings) => {
  await db.configPut(APP_CONFIG, SETTINGS_NETWORK_KEY, settings);
  db.commitSoon("update network settings");
};

export interface UiSettings {
  redUiEnabled: boolean;
}

const UI_SETTINGS_KEY = "ui";
const DEFAULT_UI_SETTINGS: UiSettings = { redUiEnabled: false };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Project-local UI flags. Stored in the .rdb so Settings > Data follows the project. */
export async function loadUiSettings(): Promise<UiSettings> {
  const raw = record(
    (await db
      .configGet<unknown>(APP_CONFIG, SETTINGS_UI_KEY)
      .catch(() => null)) ??
      (await db.kvGet<unknown>(SETTINGS, UI_SETTINGS_KEY).catch(() => null))
  );
  return {
    redUiEnabled: raw.redUiEnabled === true,
  };
}

export const saveUiSettings = async (settings: UiSettings) => {
  await db.configPut(APP_CONFIG, SETTINGS_UI_KEY, {
    ...DEFAULT_UI_SETTINGS,
    ...settings,
  });
  db.commitSoon("update ui settings");
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

export interface RequestSearchResult {
  rid: string;
  collectionId: string;
  requestId: string;
  name: string;
  kind: RequestDefinition["kind"];
  method: string;
  url: string;
  folder: string;
  target: string;
  request: RequestDefinition;
}

export async function searchRequests(
  query: string,
  limit = 25
): Promise<RequestSearchResult[]> {
  const docs = await db.documentSearchByTextField<RequestDocumentBody>(
    REQ,
    "search_text",
    query,
    limit
  );
  const out: RequestSearchResult[] = [];
  for (const doc of docs) {
    const body = parseRequestDocumentBody(doc.body);
    if (!body) continue;
    out.push({
      rid: doc.rid,
      collectionId: body.collection_id,
      requestId: body.request_id,
      name: body.request_name,
      kind: body.request_kind,
      method: body.request_method,
      url: body.request_url,
      folder: body.request_folder,
      target: body.request_target,
      request: body.request,
    });
  }
  return out;
}

const GLOBALS_KEY = "globals";
/** Project-level base variables (formerly per-collection `vars`). Null = never set. */
export async function loadGlobals(): Promise<Record<string, string> | null> {
  const raw =
    (await db
      .configGet<Record<string, string>>(APP_CONFIG, SETTINGS_GLOBALS_KEY)
      .catch(() => null)) ??
    (await db
      .kvGet<Record<string, string>>(SETTINGS, GLOBALS_KEY)
      .catch(() => null));
  return raw ?? null;
}
export const saveGlobals = async (vars: Record<string, string>) => {
  await db.configPut(APP_CONFIG, SETTINGS_GLOBALS_KEY, vars);
  db.commitSoon("update globals");
};

async function loadNativeEnvironments(): Promise<StoredEnvironment[]> {
  const rows = await db.configList<unknown>(APP_CONFIG, ENV_CONFIG_PREFIX);
  const out: StoredEnvironment[] = [];
  for (const { value } of rows) {
    try {
      out.push(storedEnvironmentSchema.parse(value));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      appLog("warn", `native environment config ignored: ${detail}`);
    }
  }
  return out;
}

async function legacyEnvironmentRows(): Promise<
  Array<{ key: string; value: StoredEnvironment }>
> {
  const rows = await db.kvList<unknown>(ENV).catch(() => []);
  const byName = new Map<string, { key: string; value: StoredEnvironment }>();
  for (const row of rows) {
    try {
      const env = storedEnvironmentSchema.parse(row.value);
      byName.set(env.name, { key: row.key, value: env });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      appLog("warn", `legacy environment ignored: ${detail}`);
    }
  }
  return [...byName.values()];
}

async function deleteLegacyEnvironmentRows(name: string): Promise<void> {
  const rows = await db.kvList<unknown>(ENV).catch(() => []);
  await Promise.all(
    rows.map(async (row) => {
      try {
        const env = storedEnvironmentSchema.parse(row.value);
        if (env.name === name) await db.kvDelete(ENV, row.key);
      } catch {
        /* ignore malformed legacy rows */
      }
    })
  );
}

async function writeNativeSecretReference(
  envName: string,
  secretName: string,
  missing = false
): Promise<NativeSecretRef> {
  const ref = nativeSecretRef(envName, secretName, missing);
  await db.ensureVaultCollection(APP_VAULT);
  await db.configPutSecretRef(APP_CONFIG, ref.configKey, ref.ref);
  return ref;
}

async function writeNativeSecret(
  envName: string,
  secretName: string,
  value: string
): Promise<NativeSecretRef> {
  const ref = nativeSecretRef(envName, secretName);
  await db.ensureVaultCollection(APP_VAULT);
  await db.vaultPut(ref.ref, value);
  await db.configPutSecretRef(APP_CONFIG, ref.configKey, ref.ref);
  return ref;
}

async function deleteNativeSecretReference(
  secret: NativeSecretRef
): Promise<void> {
  await Promise.all([
    db.configDelete(APP_CONFIG, secret.configKey).catch(() => {}),
    db.vaultDelete(secret.ref).catch(() => {}),
  ]);
}

async function migrateLegacyEnvironment(
  legacy: StoredEnvironment
): Promise<StoredEnvironment> {
  const migrated = storedEnvironmentSchema.parse({
    name: legacy.name,
    vars: legacy.vars,
    secrets: {},
  });

  for (const [name, secret] of Object.entries(legacy.secrets)) {
    if (isNativeSecret(secret)) {
      migrated.secrets[name] = secret;
      continue;
    }
    if (!isSealedSecret(secret)) continue;
    try {
      const opened = await secrets.open(sealedSecretSchema.parse(secret));
      migrated.secrets[name] = await writeNativeSecret(
        legacy.name,
        name,
        opened
      );
    } catch {
      migrated.secrets[name] = await writeNativeSecretReference(
        legacy.name,
        name,
        true
      );
    }
  }

  await saveEnvironment(migrated);
  return migrated;
}

/** Load project-level environments from RedDB-native CONFIG. Legacy
 *  rr_environments KV rows are migration sources only; new writes never land there. */
export async function loadEnvironments(): Promise<StoredEnvironment[]> {
  const native = await loadNativeEnvironments();
  const byName = new Map(native.map((env) => [env.name, env]));
  const legacy = await legacyEnvironmentRows();
  let migratedAny = false;

  for (const { value } of legacy) {
    if (byName.has(value.name)) continue;
    const migrated = await migrateLegacyEnvironment(value);
    byName.set(migrated.name, migrated);
    migratedAny = true;
  }

  if (migratedAny)
    db.commitSoon("migrate environments to native config/secrets");

  const order = await loadEnvironmentOrder();
  const orderIndex = new Map(order.map((name, index) => [name, index]));
  return [...byName.values()].sort((a, b) => {
    const ai = orderIndex.get(a.name) ?? Number.MAX_SAFE_INTEGER;
    const bi = orderIndex.get(b.name) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });
}

export async function loadEnvironmentOrder(): Promise<string[]> {
  const raw = await db
    .configGet<unknown>(APP_CONFIG, SETTINGS_ENV_ORDER_KEY)
    .catch(() => null);
  return Array.isArray(raw)
    ? raw.filter((name): name is string => typeof name === "string")
    : [];
}

export async function saveEnvironmentOrder(names: string[]): Promise<void> {
  await db.configPut(APP_CONFIG, SETTINGS_ENV_ORDER_KEY, [...new Set(names)]);
  db.commitSoon("reorder environments");
}

export async function resolveEnvironmentSecret(
  env: StoredEnvironment,
  name: string
): Promise<string | null> {
  const secret = env.secrets[name];
  if (!secret) return null;
  if (isNativeSecret(secret)) {
    return db.configResolve<string>(APP_CONFIG, secret.configKey);
  }
  const opened = await secrets.open(sealedSecretSchema.parse(secret));
  const ref = await writeNativeSecret(env.name, name, opened);
  env.secrets[name] = ref;
  await saveEnvironment(env);
  return opened;
}

export async function saveEnvironmentSecret(
  env: StoredEnvironment,
  name: string,
  value: string
): Promise<void> {
  env.secrets[name] = await writeNativeSecret(env.name, name, value);
  await saveEnvironment(env);
}

export async function saveEnvironmentMissingSecret(
  env: StoredEnvironment,
  name: string
): Promise<void> {
  env.secrets[name] = await writeNativeSecretReference(env.name, name, true);
  await saveEnvironment(env);
}

export async function removeEnvironmentSecret(
  env: StoredEnvironment,
  name: string
): Promise<void> {
  const secret = env.secrets[name];
  delete env.secrets[name];
  await saveEnvironment(env);
  if (!secret || !isNativeSecret(secret)) return;
  await deleteNativeSecretReference(secret);
}

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
  await db.configPut(
    APP_CONFIG,
    nativeEnvKey(env.name),
    storedEnvironmentSchema.parse(env)
  );
  db.commitSoon(`save environment ${env.name}`);
};

async function deleteEnvironmentRecord(name: string): Promise<void> {
  await db.configDelete(APP_CONFIG, nativeEnvKey(name)).catch(() => {});
  await deleteLegacyEnvironmentRows(name);
}

export const renameEnvironment = async (
  oldName: string,
  env: StoredEnvironment
) => {
  const renamed = storedEnvironmentSchema.parse({
    name: env.name,
    vars: env.vars,
    secrets: {},
  });
  const oldNativeSecrets: NativeSecretRef[] = [];

  for (const [name, secret] of Object.entries(env.secrets)) {
    if (isNativeSecret(secret)) {
      oldNativeSecrets.push(secret);
      if (secret.missing === true) {
        renamed.secrets[name] = await writeNativeSecretReference(
          env.name,
          name,
          true
        );
        continue;
      }
      const value = await db
        .configResolve<string>(APP_CONFIG, secret.configKey)
        .catch(() => null);
      renamed.secrets[name] =
        value === null
          ? await writeNativeSecretReference(env.name, name, true)
          : await writeNativeSecret(env.name, name, value);
      continue;
    }
    if (!isSealedSecret(secret)) continue;
    try {
      const opened = await secrets.open(sealedSecretSchema.parse(secret));
      renamed.secrets[name] = await writeNativeSecret(env.name, name, opened);
    } catch {
      renamed.secrets[name] = await writeNativeSecretReference(
        env.name,
        name,
        true
      );
    }
  }

  env.secrets = renamed.secrets;
  await saveEnvironment(renamed);
  await deleteEnvironmentRecord(oldName);
  await Promise.all(oldNativeSecrets.map(deleteNativeSecretReference));
  db.commitSoon(`rename environment ${oldName} to ${env.name}`);
};

export const deleteEnvironment = async (name: string) => {
  const existing = (await loadNativeEnvironments()).find(
    (env) => env.name === name
  );
  if (existing) {
    await Promise.all(
      Object.values(existing.secrets).map((secret) =>
        isNativeSecret(secret)
          ? deleteNativeSecretReference(secret)
          : Promise.resolve()
      )
    );
  }
  await deleteEnvironmentRecord(name);
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
