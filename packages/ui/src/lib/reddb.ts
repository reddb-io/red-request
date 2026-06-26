// RedDB client. Most operations are RQL (RedDB's SQL) sent through the Rust
// `reddb_rql` command, which runs `red connect` — the native conduit shared by
// the local embedded server and remote `reds://` connections. KV ops use the
// native `KV PUT/GET/DELETE` / `LIST KV` verbs (model stays `kv`); values are
// JSON strings. Document mutations use the embedded HTTP API so nested edits can
// be persisted as JSON-pointer patches instead of whole-value string rewrites.
import { invoke } from "@tauri-apps/api/core";

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
  let reply: HttpReply | null = null;
  for (let i = 0; i < 80; i++) {
    try {
      reply = await invoke<HttpReply>("reddb_rql", { query });
      break;
    } catch (e) {
      if (i === 79) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!reply) return { ok: false, records: [], columns: [], error: "no reply" };
  let j: {
    ok?: boolean;
    error?: string;
    data?: { columns?: string[]; records?: Array<Record<string, unknown>> };
  };
  try {
    j = JSON.parse(reply.body);
  } catch {
    return {
      ok: false,
      records: [],
      columns: [],
      error: reply.body.slice(0, 200),
    };
  }
  if (!j.ok)
    return {
      ok: false,
      records: [],
      columns: [],
      error: j.error ?? "rql error",
    };
  return {
    ok: true,
    records: j.data?.records ?? [],
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

export type IndexMethod = "BTREE" | "HASH" | "BITMAP" | "RTREE";

/** Ensure a secondary index exists. Search still works without these, so callers may
 *  decide whether an index failure is fatal for their boot path. */
export async function ensureIndex(
  collection: string,
  name: string,
  columns: string[],
  opts: { method?: IndexMethod; unique?: boolean } = {}
): Promise<void> {
  if (columns.length === 0)
    throw new Error("index requires at least one column");
  const unique = opts.unique ? "UNIQUE " : "";
  const method = opts.method ? ` USING ${opts.method}` : "";
  const r = await rql(
    `CREATE ${unique}INDEX IF NOT EXISTS ${ident(name)} ON ${ident(
      collection
    )} (${columns.map(ident).join(", ")})${method}`
  );
  if (!r.ok) throw new Error(`CREATE INDEX ${name}: ${r.error}`);
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
// RedDB ships a first-class migration system in the query engine: `CREATE MIGRATION`
// registers SQL (status pending, stored in the `red_migrations` system collection),
// and `APPLY MIGRATION *` runs every pending one in dependency order (Kahn topo-sort),
// resumable for BATCH data migrations. We register the app's shipped migrations
// (idempotently) and apply all pending on every project boot.

/** A migration the app ships and guarantees is applied. `sql` is the body after `AS`. */
export interface MigrationDef {
  name: string;
  sql: string;
  dependsOn?: string[];
}

/** Register any shipped migrations not yet in `red_migrations`, then apply all pending.
 *  Idempotent and safe to run on every boot (no-op when nothing is pending). Routes
 *  through the `red connect` RQL conduit (Phase 1 of the unified local/remote path). */
export async function runMigrations(defs: MigrationDef[]): Promise<void> {
  if (defs.length) {
    const existing = await rql("SELECT name FROM red_migrations");
    const have = new Set(existing.records.map((r) => r.name as string));
    for (const d of defs) {
      if (have.has(d.name)) continue;
      const dep = d.dependsOn?.length
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
  try {
    const reply = await invoke<HttpReply>("reddb_request", {
      method,
      path,
      body: body === undefined ? null : JSON.stringify(body),
    });
    let json: unknown = null;
    try {
      json = JSON.parse(reply.body);
    } catch {
      /* non-JSON body */
    }
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json,
    };
  } catch {
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
