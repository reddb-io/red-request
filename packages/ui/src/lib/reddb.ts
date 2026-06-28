// RedDB client. Most operations are RQL (RedDB's SQL) sent through the Rust
// `reddb_rql` command, which runs `red connect` — the native conduit shared by
// the local embedded server and remote `reds://` connections. KV ops use the
// native `KV PUT/GET/DELETE` / `LIST KV` verbs (model stays `kv`); values are
// JSON strings. Document mutations use the embedded HTTP API so nested edits can
// be persisted as JSON-pointer patches instead of whole-value string rewrites.
import { invoke } from "@tauri-apps/api/core";
import {
  developerConsole,
  developerConsoleDuration,
  markDeveloperConsoleStart,
} from "./developer-console.svelte";

interface HttpReply {
  status: number;
  body: string;
}

/** Escape a single-quoted RQL string literal. */
const esc = (s: string) => s.replace(/'/g, "''");
/** A conservative bare identifier for app-owned collection/field names. */
const ident = (s: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s))
    throw new Error(`invalid RedDB identifier: ${s}`);
  return s;
};
/** A `collection.'key'` reference — the key quoted so dots/colons stay literal. */
const kvRef = (collection: string, key: string) =>
  `${ident(collection)}.'${esc(key)}'`;
const plainPathSegment = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
const pathSegment = (s: string) => (plainPathSegment(s) ? s : `'${esc(s)}'`);
const pathRef = (path: string) => {
  const segments = path.split(".");
  if (
    segments.length < 2 ||
    segments.some((segment) => !plainPathSegment(segment))
  )
    throw new Error(`invalid RedDB path: ${path}`);
  return segments.join(".");
};

/** Result of an RQL statement run via the `red connect` conduit. */
export interface RqlResult {
  ok: boolean;
  /** Flat result rows (column → value), as `red connect --json` returns them. */
  records: Array<Record<string, unknown>>;
  columns: string[];
  error?: string;
}

/** Run an RQL statement (RedDB's SQL) through `red connect` — the native conduit shared
 *  by local and remote (`reds://`) connections. Retries until the server is ready. */
export async function rql(query: string): Promise<RqlResult> {
  const started = markDeveloperConsoleStart();
  let reply: HttpReply | null = null;
  let attempts = 0;
  for (let i = 0; i < 80; i++) {
    attempts = i + 1;
    try {
      reply = await invoke<HttpReply>("reddb_rql", { query });
      break;
    } catch (e) {
      if (i === 79) {
        developerConsole.logReddbRql({
          query,
          ok: false,
          durationMs: developerConsoleDuration(started),
          attempts,
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!reply) {
    developerConsole.logReddbRql({
      query,
      ok: false,
      durationMs: developerConsoleDuration(started),
      attempts,
      error: "no reply",
    });
    return { ok: false, records: [], columns: [], error: "no reply" };
  }
  let j: {
    ok?: boolean;
    error?: string;
    data?: { columns?: string[]; records?: Array<Record<string, unknown>> };
  };
  try {
    j = JSON.parse(reply.body);
  } catch {
    developerConsole.logReddbRql({
      query,
      ok: false,
      durationMs: developerConsoleDuration(started),
      attempts,
      error: reply.body.slice(0, 200),
    });
    return {
      ok: false,
      records: [],
      columns: [],
      error: reply.body.slice(0, 200),
    };
  }
  if (!j.ok) {
    developerConsole.logReddbRql({
      query,
      ok: false,
      durationMs: developerConsoleDuration(started),
      attempts,
      error: j.error ?? "rql error",
    });
    return {
      ok: false,
      records: [],
      columns: [],
      error: j.error ?? "rql error",
    };
  }
  const records = j.data?.records ?? [];
  const columns = j.data?.columns ?? [];
  // Stringify the response so the dev console's right pane can render it
  // pretty-printed (and so the response is preserved verbatim when the consumer
  // throws the records away after this point). The store truncates to ~2000
  // chars — enough to teach "this is what SELECT … returned" without flooding
  // the on-screen buffer for queries that return a whole table.
  const payload = JSON.stringify({ columns, records }, null, 2);
  developerConsole.logReddbRql({
    query,
    ok: true,
    durationMs: developerConsoleDuration(started),
    attempts,
    rows: records.length,
    payload,
  });
  return {
    ok: true,
    records,
    columns: j.data?.columns ?? [],
  };
}

/**
 * Ensure `name` exists as a KV collection. `CREATE KV` errors if it already exists, so we
 * check the `red.collections` catalog first and only create when absent.
 */
export async function ensureKvCollection(name: string): Promise<void> {
  const found = await rql(
    `SELECT name FROM red.collections WHERE name = '${esc(name)}'`
  );
  if (found.ok && found.records.length > 0) return;
  const c = await rql(`CREATE KV ${ident(name)}`);
  if (!c.ok && !/already exists/i.test(c.error ?? ""))
    throw new Error(`CREATE KV ${name}: ${c.error}`);
}

/** Logical model recorded in `red.collections`, or null when absent. */
export async function collectionModel(name: string): Promise<string | null> {
  const found = await rql(
    `SELECT model FROM red.collections WHERE name = '${esc(name)}' LIMIT 1`
  );
  if (!found.ok || found.records.length === 0) return null;
  const model = found.records[0]?.model;
  return typeof model === "string" ? model : null;
}

/** Drop an app-owned collection, regardless of its current model. */
export async function dropCollection(name: string): Promise<void> {
  const r = await rql(`DROP COLLECTION IF EXISTS ${ident(name)}`);
  if (!r.ok) throw new Error(`DROP COLLECTION ${name}: ${r.error}`);
}

export async function kvPut(
  collection: string,
  key: string,
  value: unknown
): Promise<void> {
  const r = await rql(
    `KV PUT ${kvRef(collection, key)} = '${esc(JSON.stringify(value))}'`
  );
  if (!r.ok) throw new Error(`kvPut ${collection}/${key}: ${r.error}`);
}

export async function kvGet<T>(
  collection: string,
  key: string
): Promise<T | null> {
  const r = await rql(`KV GET ${kvRef(collection, key)}`);
  if (!r.ok || r.records.length === 0) return null;
  const v = r.records[0]!.value;
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

export async function kvDelete(collection: string, key: string): Promise<void> {
  await rql(`KV DELETE ${kvRef(collection, key)}`);
}

export async function kvCount(collection: string): Promise<number> {
  const r = await rql(`LIST KV ${ident(collection)}`);
  return r.ok ? r.records.length : 0;
}

/** Every entry of a KV collection (`LIST KV`). Values are parsed back from their JSON. */
export async function kvList<T>(
  collection: string
): Promise<Array<{ key: string; value: T }>> {
  const r = await rql(`LIST KV ${ident(collection)}`);
  if (!r.ok) return [];
  const out: Array<{ key: string; value: T }> = [];
  for (const rec of r.records) {
    const k = rec.key;
    const v = rec.value;
    if (typeof k !== "string" || typeof v !== "string") continue;
    try {
      out.push({ key: k, value: JSON.parse(v) as T });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

// --- RedDB native config / secret -----------------------------------------

function configLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return `'${esc(value)}' WITH TYPE string`;
  if (typeof value === "boolean") return `${value} WITH TYPE bool`;
  if (typeof value === "number" && Number.isFinite(value))
    return `${value} WITH TYPE ${Number.isInteger(value) ? "int" : "float"}`;
  if (Array.isArray(value)) return `${JSON.stringify(value)} WITH TYPE array`;
  if (isRecord(value)) return `${JSON.stringify(value)} WITH TYPE object`;
  throw new Error(`unsupported RedDB config value: ${typeof value}`);
}

function configValue<T>(value: unknown): T {
  if (typeof value !== "string") return value as T;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
}

export async function configPut(
  collection: string,
  key: string,
  value: unknown
): Promise<void> {
  const r = await rql(
    `PUT CONFIG ${ident(collection)} ${pathSegment(key)} = ${configLiteral(value)}`
  );
  if (!r.ok) throw new Error(`PUT CONFIG ${collection}/${key}: ${r.error}`);
}

export async function configPutSecretRef(
  collection: string,
  key: string,
  vaultPath: string
): Promise<void> {
  const r = await rql(
    `PUT CONFIG ${ident(collection)} ${pathSegment(
      key
    )} = SECRET_REF(vault, ${pathRef(vaultPath)})`
  );
  if (!r.ok)
    throw new Error(`PUT CONFIG SECRET_REF ${collection}/${key}: ${r.error}`);
}

export async function configGet<T>(
  collection: string,
  key: string
): Promise<T | null> {
  const r = await rql(`GET CONFIG ${ident(collection)} ${pathSegment(key)}`);
  if (!r.ok || r.records.length === 0) return null;
  const row = r.records[0]!;
  if (row.tombstone === true || row.value === null || row.value === undefined)
    return null;
  return configValue<T>(row.value);
}

export async function configResolve<T>(
  collection: string,
  key: string
): Promise<T | null> {
  const r = await rql(
    `RESOLVE CONFIG ${ident(collection)} ${pathSegment(key)}`
  );
  if (!r.ok || r.records.length === 0) return null;
  const value = r.records[0]!.value;
  return value === null || value === undefined ? null : configValue<T>(value);
}

export async function configList<T>(
  collection: string,
  prefix?: string
): Promise<Array<{ key: string; value: T }>> {
  const r = await rql(
    `LIST CONFIG ${ident(collection)}${
      prefix ? ` PREFIX ${pathSegment(prefix)}` : ""
    }`
  );
  if (!r.ok) return [];
  const out: Array<{ key: string; value: T }> = [];
  for (const row of r.records) {
    if (typeof row.key !== "string" || row.tombstone === true) continue;
    if (row.value === null || row.value === undefined) continue;
    out.push({ key: row.key, value: configValue<T>(row.value) });
  }
  return out;
}

export async function configDelete(
  collection: string,
  key: string
): Promise<void> {
  const r = await rql(`DELETE CONFIG ${ident(collection)} ${pathSegment(key)}`);
  if (!r.ok) throw new Error(`DELETE CONFIG ${collection}/${key}: ${r.error}`);
}

export async function ensureVaultCollection(collection: string): Promise<void> {
  const r = await rql(
    `CREATE VAULT IF NOT EXISTS ${ident(collection)} WITH OWN MASTER KEY`
  );
  if (!r.ok) throw new Error(`CREATE VAULT ${collection}: ${r.error}`);
}

export async function vaultPut(path: string, value: string): Promise<void> {
  const r = await rql(`VAULT PUT ${pathRef(path)} = '${esc(value)}'`);
  if (!r.ok) throw new Error(`VAULT PUT ${path}: ${r.error}`);
}

export async function vaultDelete(path: string): Promise<void> {
  const r = await rql(`DELETE VAULT ${pathRef(path)}`);
  if (!r.ok) throw new Error(`DELETE VAULT ${path}: ${r.error}`);
}

export async function vaultUnseal(path: string): Promise<string | null> {
  const r = await rql(`UNSEAL VAULT ${pathRef(path)}`);
  if (!r.ok || r.records.length === 0) return null;
  const value = r.records[0]!.value;
  return typeof value === "string" ? value : JSON.stringify(value);
}

// --- RedDB queues -----------------------------------------------------------

type QueueMode = "FANOUT";

export async function ensureQueue(
  name: string,
  mode: QueueMode = "FANOUT"
): Promise<void> {
  const r = await rql(`CREATE QUEUE IF NOT EXISTS ${ident(name)} ${mode}`);
  if (!r.ok) throw new Error(`CREATE QUEUE ${name}: ${r.error}`);
}

export async function ensureQueueGroup(
  name: string,
  group: string
): Promise<void> {
  const r = await rql(`QUEUE GROUP CREATE ${ident(name)} ${ident(group)}`);
  if (!r.ok) throw new Error(`QUEUE GROUP CREATE ${name}/${group}: ${r.error}`);
}

export async function queuePush(name: string, payload: unknown): Promise<void> {
  const r = await rql(`QUEUE PUSH ${ident(name)} ${JSON.stringify(payload)}`);
  if (!r.ok) throw new Error(`QUEUE PUSH ${name}: ${r.error}`);
}

export interface QueueMessage<T = unknown> {
  messageId: string;
  deliveryId?: string;
  group?: string;
  payload: T;
  consumer?: string;
  deliveryCount?: number;
}

function queueMessageFrom<T>(
  row: Record<string, unknown>,
  group?: string
): QueueMessage<T> | null {
  const messageId = row.message_id;
  if (typeof messageId !== "string" || messageId.length === 0) return null;
  const deliveryId = row.delivery_id;
  const deliveryCount = row.delivery_count;
  const consumer = row.consumer;
  return {
    messageId,
    deliveryId: typeof deliveryId === "string" ? deliveryId : undefined,
    group,
    payload: parseMaybeJson(row.payload) as T,
    consumer: typeof consumer === "string" ? consumer : undefined,
    deliveryCount:
      typeof deliveryCount === "number" ? deliveryCount : undefined,
  };
}

export async function queueReadWait<T>(
  name: string,
  consumer: string,
  count = 10,
  waitMs = 15_000,
  group?: string
): Promise<QueueMessage<T>[]> {
  const safeCount = Math.max(1, Math.min(100, Math.floor(count) || 10));
  const safeWaitMs = Math.max(0, Math.min(30_000, Math.floor(waitMs) || 0));
  const groupClause = group ? ` GROUP ${ident(group)}` : "";
  const r = await rql(
    `QUEUE READ ${ident(name)}${groupClause} CONSUMER ${ident(
      consumer
    )} COUNT ${safeCount} WAIT ${safeWaitMs}ms`
  );
  if (!r.ok) throw new Error(`QUEUE READ ${name}: ${r.error}`);
  return r.records
    .map((row) => queueMessageFrom<T>(row, group))
    .filter((row): row is QueueMessage<T> => row !== null);
}

export async function queueAck(
  name: string,
  messageId: string,
  deliveryId?: string,
  group?: string
): Promise<void> {
  const r = await rql(
    deliveryId
      ? `QUEUE ACK ${ident(name)} WITH delivery_id = '${esc(deliveryId)}'`
      : group
        ? `QUEUE ACK ${ident(name)} GROUP ${ident(group)} '${esc(messageId)}'`
        : `QUEUE ACK ${ident(name)} '${esc(messageId)}'`
  );
  if (!r.ok) throw new Error(`QUEUE ACK ${name}/${messageId}: ${r.error}`);
}

// --- RedDB documents --------------------------------------------------------

export interface DocumentRecord<T = unknown> {
  rid: string;
  body: T;
  raw: Record<string, unknown>;
}

export type DocumentPatchOperation =
  | { op: "set"; path: string; value: unknown }
  | { op: "unset"; path: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function ridFrom(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

const PROMOTED_DOCUMENT_SKIP = new Set([
  "rid",
  "id",
  "collection",
  "kind",
  "tenant",
  "created_at",
  "updated_at",
  "identity",
  "data",
  "cross_refs",
  "metadata",
]);

function promotedBody(row: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!PROMOTED_DOCUMENT_SKIP.has(key)) body[key] = value;
  }
  return body;
}

function bodyFromEntityJson(value: unknown): unknown {
  if (!isRecord(value)) return null;
  const data = value.data;
  if (isRecord(data)) {
    const named = data.named;
    if (isRecord(named) && "body" in named) return parseMaybeJson(named.body);
  }
  if ("body" in value) return parseMaybeJson(value.body);
  return null;
}

function parseDocumentRecord<T>(
  row: Record<string, unknown>
): DocumentRecord<T> | null {
  const rid = ridFrom(row.rid) ?? ridFrom(row.id);
  if (!rid) return null;

  let body: unknown = null;
  if ("body" in row) body = parseMaybeJson(row.body);
  else if ("entity" in row) body = bodyFromEntityJson(row.entity);
  else body = promotedBody(row);

  if (body === null || body === undefined) return null;
  return { rid, body: body as T, raw: row };
}

function documentRecordFromHttp<T>(
  json: unknown,
  fallbackBody?: T
): DocumentRecord<T> | null {
  if (!isRecord(json)) return null;
  const entity = json.entity;
  const row = isRecord(entity)
    ? { ...entity, rid: json.rid ?? json.id ?? entity.rid ?? entity.id }
    : json;
  const parsed = parseDocumentRecord<T>(row);
  if (parsed) return parsed;
  const rid = ridFrom(json.rid) ?? ridFrom(json.id);
  return rid && fallbackBody !== undefined
    ? { rid, body: fallbackBody, raw: json }
    : null;
}

function httpError(
  action: string,
  collection: string,
  status: number,
  json: unknown
): Error {
  const message =
    isRecord(json) && typeof (json.message ?? json.error) === "string"
      ? ((json.message ?? json.error) as string)
      : `HTTP ${status}`;
  return new Error(`${action} ${collection}: ${message}`);
}

/** Ensure `name` exists as a Document collection. */
export async function ensureDocumentCollection(name: string): Promise<void> {
  const model = await collectionModel(name);
  if (model === "document") return;
  if (model)
    throw new Error(`collection ${name} exists as ${model}, expected document`);
  const c = await rql(`CREATE DOCUMENT ${ident(name)}`);
  if (!c.ok && !/already exists/i.test(c.error ?? ""))
    throw new Error(`CREATE DOCUMENT ${name}: ${c.error}`);
}

/** Count document entities in a collection. */
export async function documentCount(collection: string): Promise<number> {
  const r = await rql(`SELECT rid FROM ${ident(collection)}`);
  return r.ok ? r.records.length : 0;
}

function queryLimit(limit: number): number {
  return Math.max(1, Math.min(100, Math.floor(limit) || 25));
}

/** List document entities and decode their canonical `body` JSON. */
export async function documentList<T>(
  collection: string
): Promise<DocumentRecord<T>[]> {
  const r = await rql(`SELECT rid, body FROM ${ident(collection)}`);
  if (!r.ok) return [];
  return r.records
    .map((row) => parseDocumentRecord<T>(row))
    .filter((row): row is DocumentRecord<T> => row !== null);
}

/** Search documents by a lower-cased promoted text field. Multiple terms are ANDed
 *  so command-palette queries like "post users" stay precise without a full parser. */
export async function documentSearchByTextField<T>(
  collection: string,
  field: string,
  query: string,
  limit = 25
): Promise<DocumentRecord<T>[]> {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  const where = terms.length
    ? ` WHERE ${terms
        .map((term) => `${ident(field)} LIKE '%${esc(term)}%'`)
        .join(" AND ")}`
    : "";
  const r = await rql(
    `SELECT rid, body FROM ${ident(collection)}${where} LIMIT ${queryLimit(
      limit
    )}`
  );
  if (!r.ok) return [];
  return r.records
    .map((row) => parseDocumentRecord<T>(row))
    .filter((row): row is DocumentRecord<T> => row !== null);
}

/** Read one document by a promoted top-level body field. */
export async function documentFindByField<T>(
  collection: string,
  field: string,
  value: string
): Promise<DocumentRecord<T> | null> {
  const r = await rql(
    `SELECT rid, body FROM ${ident(collection)} WHERE ${ident(field)} = '${esc(value)}' LIMIT 1`
  );
  if (!r.ok || r.records.length === 0) return null;
  return parseDocumentRecord<T>(r.records[0]!);
}

/** Time-travel read of one document by a promoted top-level body field. */
export async function documentFindByFieldAsOf<T>(
  collection: string,
  field: string,
  value: string,
  commitHash: string
): Promise<DocumentRecord<T> | null> {
  const r = await rql(
    `SELECT rid, body FROM ${ident(collection)} AS OF COMMIT '${esc(commitHash)}' WHERE ${ident(field)} = '${esc(value)}' LIMIT 1`
  );
  if (!r.ok || r.records.length === 0) return null;
  return parseDocumentRecord<T>(r.records[0]!);
}

/** Insert one document through HTTP so RedDB stores canonical JSON in `body`. */
export async function documentInsert<T>(
  collection: string,
  body: T
): Promise<DocumentRecord<T>> {
  const r = await reddbHttp(
    "POST",
    `/collections/${encodeURIComponent(collection)}/documents`,
    { body }
  );
  if (!r.ok) throw httpError("documentInsert", collection, r.status, r.json);
  const rec = documentRecordFromHttp<T>(r.json, body);
  if (!rec) throw new Error(`documentInsert ${collection}: missing rid`);
  return rec;
}

/** Patch nested document fields with RedDB JSON-pointer operations. */
export async function documentPatch(
  collection: string,
  rid: string,
  operations: DocumentPatchOperation[]
): Promise<void> {
  if (operations.length === 0) return;
  const r = await reddbHttp(
    "PATCH",
    `/collections/${encodeURIComponent(collection)}/entities/${encodeURIComponent(rid)}`,
    { operations }
  );
  if (!r.ok) throw httpError("documentPatch", collection, r.status, r.json);
}

/** Replace a document's canonical body. Used only when the stored envelope is malformed. */
export async function documentReplace<T>(
  collection: string,
  rid: string,
  body: T
): Promise<void> {
  const r = await reddbHttp(
    "PATCH",
    `/collections/${encodeURIComponent(collection)}/entities/${encodeURIComponent(rid)}`,
    { body }
  );
  if (!r.ok) throw httpError("documentReplace", collection, r.status, r.json);
}

export async function documentDelete(
  collection: string,
  rid: string
): Promise<void> {
  const r = await reddbHttp(
    "DELETE",
    `/collections/${encodeURIComponent(collection)}/entities/${encodeURIComponent(rid)}`
  );
  if (!r.ok && r.status !== 404)
    throw httpError("documentDelete", collection, r.status, r.json);
}

// --- RedDB-native SQL migrations -------------------------------------------
// RedDB ships a migration system in the query engine: `CREATE MIGRATION`
// registers SQL (status pending, stored in the `red_migrations` system collection),
// and `APPLY MIGRATION *` runs pending migrations. The app intentionally uses a
// conservative subset here: simple schema/index migrations, explicit dependencies
// between app-shipped migrations, and no BATCH / rollback / tenant fanout contract.
// We register the app's shipped migrations idempotently and apply pending ones on
// every project boot.

/** A migration the app ships and guarantees is applied. `sql` is the body after `AS`. */
export interface MigrationDef {
  name: string;
  sql: string;
  dependsOn?: string[];
}

interface PreparedMigrationDef {
  name: string;
  sql: string;
  dependsOn: string[];
}

const REDDB_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertRedDbIdentifier(value: string, label: string): string {
  if (REDDB_IDENTIFIER_RE.test(value)) return value;
  const digitHint = /^\d/.test(value)
    ? " RedDB identifiers cannot start with a digit."
    : "";
  throw new Error(
    `invalid RedDB ${label} "${value}": must match ${REDDB_IDENTIFIER_RE}.${digitHint}`
  );
}

function prepareMigrationDefinitions(
  defs: MigrationDef[]
): PreparedMigrationDef[] {
  const out: PreparedMigrationDef[] = [];
  const names = new Set<string>();

  for (const d of defs) {
    const name = assertRedDbIdentifier(d.name, "migration name");
    if (names.has(name))
      throw new Error(`duplicate RedDB migration name "${name}"`);
    names.add(name);

    const sql = d.sql.trim();
    if (!sql)
      throw new Error(`invalid RedDB migration "${name}": SQL is empty`);
    if (sql.includes("\0"))
      throw new Error(`invalid RedDB migration "${name}": SQL contains NUL`);
    if (/^CREATE\s+MIGRATION\b/i.test(sql))
      throw new Error(
        `invalid RedDB migration "${name}": sql must be the body after AS`
      );
    if (/^BATCH\s+\d+\s+ROWS\b/i.test(sql))
      throw new Error(
        `invalid RedDB migration "${name}": BATCH is not supported by this app wrapper`
      );

    const dependsOn = (d.dependsOn ?? []).map((dep) =>
      assertRedDbIdentifier(dep, "migration dependency")
    );
    if (dependsOn.includes(name))
      throw new Error(`invalid RedDB migration "${name}": depends on itself`);
    out.push({ name, sql, dependsOn });
  }

  for (const d of out) {
    for (const dep of d.dependsOn) {
      if (!names.has(dep))
        throw new Error(
          `invalid RedDB migration "${d.name}": unknown dependency "${dep}"`
        );
    }
  }

  return out;
}

/** Register any shipped migrations not yet in `red_migrations`, then apply all pending.
 *  Idempotent and safe to run on every boot (no-op when nothing is pending). Routes
 *  through the `red connect` RQL conduit (Phase 1 of the unified local/remote path). */
export async function runMigrations(defs: MigrationDef[]): Promise<void> {
  const migrations = prepareMigrationDefinitions(defs);
  if (migrations.length) {
    const existing = await rql("SELECT name, status FROM red_migrations");
    if (!existing.ok)
      throw new Error(`failed to inspect RedDB migrations: ${existing.error}`);
    const have = new Map(
      existing.records
        .filter((r) => typeof r.name === "string")
        .map((r) => [r.name as string, r.status])
    );
    for (const d of migrations) {
      const status = have.get(d.name);
      if (status === "failed")
        throw new Error(`RedDB migration ${d.name} is failed`);
      if (status !== undefined) continue;
      const dep = d.dependsOn.length
        ? ` DEPENDS ON ${d.dependsOn.join(", ")}`
        : "";
      const r = await rql(`CREATE MIGRATION ${d.name}${dep} AS ${d.sql}`);
      if (!r.ok)
        throw new Error(`failed to register migration ${d.name}: ${r.error}`);
    }
  }
  const applied = await rql("APPLY MIGRATION *");
  if (!applied.ok)
    throw new Error(`APPLY MIGRATION * failed: ${applied.error}`);
}

/** Applied / pending counts for the Settings → Data store summary. */
export async function migrationSummary(): Promise<{
  applied: number;
  pending: number;
  failed: number;
}> {
  const r = await rql("SELECT status FROM red_migrations").catch(() => null);
  const out = { applied: 0, pending: 0, failed: 0 };
  if (!r || !r.ok) return out;
  for (const row of r.records) {
    if (row.status === "applied") out.applied++;
    else if (row.status === "pending") out.pending++;
    else if (row.status === "failed") out.failed++;
  }
  return out;
}

// --- RedDB-native VCS ("Git for Data") -------------------------------------
// reddb ≥1.15 retains MVCC history for KV collections opted into versioning, so
// `SELECT ... AS OF COMMIT '<hash>'` time-travels each key. Writes go through the
// gRPC `red connect` conduit (autocommit connection 0); a commit is an HTTP
// `POST /repo/commits {connection_id:0}` on the SAME embedded server — it pins the
// current global snapshot (root_xid), so AS OF reads of prior versions resolve.
// Validated against reddb 1.15.0; commit needs author+email and AS OF needs the full
// 64-char hash. Commits are best-effort: the data is already persisted by the write,
// so a failed commit only costs a missing restore point (never data).

/** Raw request to the embedded reddb HTTP/repo API, via the Rust `reddb_request`
 *  proxy (sidesteps the webview mixed-content block, frames Content-Length). */
async function reddbHttp(
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const started = markDeveloperConsoleStart();
  const serialized = body === undefined ? null : JSON.stringify(body);
  try {
    const reply = await invoke<HttpReply>("reddb_request", {
      method,
      path,
      body: serialized,
    });
    let json: unknown = null;
    try {
      json = JSON.parse(reply.body);
    } catch {
      /* non-JSON body */
    }
    developerConsole.logReddbHttp({
      method,
      path,
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      durationMs: developerConsoleDuration(started),
      bodyBytes: serialized?.length,
    });
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json,
    };
  } catch (error) {
    developerConsole.logReddbHttp({
      method,
      path,
      ok: false,
      status: 0,
      durationMs: developerConsoleDuration(started),
      bodyBytes: serialized?.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, status: 0, json: null };
  }
}

/** Opt a KV collection into MVCC versioning (idempotent). Required before commits
 *  can time-travel its keys. Safe on populated collections — flips a catalog flag;
 *  history starts from this point forward. Tolerant of "already versioned". */
export async function setVersioned(collection: string): Promise<void> {
  await rql(`ALTER TABLE ${ident(collection)} SET VERSIONED = true`).catch(
    () => {}
  );
}

/** A commit in the store's history — one restore point across every versioned
 *  collection. */
export interface VcsCommit {
  hash: string;
  message: string;
  author: string;
  timestampMs: number;
  /** Parent commit hashes (0 = root, 1 = normal, 2+ = merge) — drives the graph. */
  parents: string[];
  /** Commit height from the root (0-based) — reddb's linear position on the branch. */
  height: number;
}

const COMMIT_AUTHOR = "red-request";
const COMMIT_EMAIL = "app@red-request.local";

/** Create a commit pinning the current snapshot. Returns the full commit hash, or
 *  null when nothing changed / the server declined (non-fatal). */
export async function commit(message: string): Promise<string | null> {
  const r = await reddbHttp("POST", "/repo/commits", {
    connection_id: 0,
    message,
    // reddb's /repo/commits wants author as an object {name,email}.
    author: { name: COMMIT_AUTHOR, email: COMMIT_EMAIL },
    allow_empty: false,
  });
  if (!r.ok) return null;
  const hash = (r.json as { result?: { hash?: string } })?.result?.hash;
  return typeof hash === "string" ? hash : null;
}

let commitTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMessage = "edit";
/** Debounced auto-commit: coalesces a burst of edits into one restore point. Call
 *  freely from write paths; the actual commit fires `delayMs` after the last call. */
export function commitSoon(message = "edit", delayMs = 1500): void {
  pendingMessage = message;
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    commitTimer = null;
    void commit(pendingMessage);
  }, delayMs);
}

/** Recent commits, newest first. */
export async function listCommits(limit = 50): Promise<VcsCommit[]> {
  const r = await reddbHttp("GET", `/repo/commits?limit=${limit}`);
  if (!r.ok) return [];
  // Accept either {result:{commits:[...]}} or {result:[...]} or a bare array.
  const root = r.json as
    | { result?: { commits?: unknown[] } | unknown[] }
    | unknown[]
    | null;
  const raw = Array.isArray(root)
    ? root
    : Array.isArray((root as { result?: unknown[] })?.result)
      ? ((root as { result: unknown[] }).result as unknown[])
      : (((root as { result?: { commits?: unknown[] } })?.result?.commits ??
          []) as unknown[]);
  const out: VcsCommit[] = [];
  for (const c of raw) {
    const o = c as Record<string, unknown>;
    const hash = o.hash;
    if (typeof hash !== "string") continue;
    const author = o.author as { name?: string } | string | undefined;
    out.push({
      hash,
      message: typeof o.message === "string" ? o.message : "",
      author:
        typeof author === "string" ? author : (author?.name ?? COMMIT_AUTHOR),
      timestampMs:
        typeof o.timestamp_ms === "number"
          ? o.timestamp_ms
          : typeof o.timestampMs === "number"
            ? o.timestampMs
            : 0,
      parents: Array.isArray(o.parents)
        ? (o.parents as unknown[]).filter(
            (p): p is string => typeof p === "string"
          )
        : [],
      height: typeof o.height === "number" ? o.height : 0,
    });
  }
  return out;
}

/** Time-travel read: the JSON value of a KV `key` as of `commitHash` (full 64-char
 *  hash). Returns null when the key had no snapshot-visible version at that commit. */
export async function kvGetAsOf<T>(
  collection: string,
  key: string,
  commitHash: string
): Promise<T | null> {
  const r = await rql(
    `SELECT value FROM ${ident(collection)} AS OF COMMIT '${esc(commitHash)}' WHERE key = '${esc(key)}'`
  );
  if (!r.ok || r.records.length === 0) return null;
  const v = r.records[0]!.value;
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}
