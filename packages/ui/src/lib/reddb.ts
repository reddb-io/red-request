// Minimal RedDB KV client. All HTTP is proxied through the Rust `reddb_request` command
// (reqwest) — the webview's native fetch to http://127.0.0.1 is blocked as mixed content,
// and Rust gives us correct request framing for the embedded reddb. Values are JSON strings.
import { invoke } from "@tauri-apps/api/core";

interface HttpReply {
  status: number;
  body: string;
}

/** One reddb HTTP call via Rust, retrying until the sidecar is ready. */
async function request(
  method: string,
  path: string,
  body?: unknown
): Promise<HttpReply> {
  const payload = {
    method,
    path,
    body: body === undefined ? null : JSON.stringify(body),
  };
  for (let i = 0; i < 80; i++) {
    try {
      return await invoke<HttpReply>("reddb_request", payload);
    } catch (e) {
      // "reddb not ready" until the sidecar comes up — retry briefly.
      if (i === 79) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("embedded RedDB did not become ready");
}

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

/** Read a collection's declared model (`kv`/`table`/`mixed`/…), or null if it doesn't exist. */
async function collectionModel(name: string): Promise<string | null> {
  // Query the system table (always `table` model, so this SELECT can't mis-declare anything).
  const r = await request("POST", "/query", {
    query: `SELECT model FROM red.collections WHERE name = '${name}'`,
  });
  if (r.status >= 300) return null;
  try {
    const j = JSON.parse(r.body) as {
      result?: { records?: Array<{ values?: { model?: string } }> };
    };
    return j.result?.records?.[0]?.values?.model ?? null;
  } catch {
    return null;
  }
}

/**
 * Ensure `name` is usable as a KV collection.
 *
 * In reddb 1.11.0 a collection's model is fixed by first use: the first `PUT …/kvs/{key}`
 * auto-creates it as model `kv` (exactly what we want), so we deliberately do NOT pre-create
 * it — a bare `POST /collections` only yields a transient `mixed` model and can't set `kv`.
 * The hazard is a store written by an OLDER build, whose `kvList` used `SELECT` and thus
 * locked these collections to model `table`, which now rejects KV writes with
 * `INVALID_OPERATION`. `POST` is idempotent and won't change an existing model, so we heal:
 * if the collection already exists with a non-`kv` model, drop it (its rows are already
 * invisible to our `/scan` reader) and let the first `kvPut` recreate it as `kv`.
 */
export async function ensureKvCollection(name: string): Promise<void> {
  const model = await collectionModel(name);
  if (model && model !== "kv") {
    await request("DELETE", `/collections/${name}`);
  }
}

export async function kvPut(
  collection: string,
  key: string,
  value: unknown
): Promise<void> {
  const r = await request("PUT", `/collections/${collection}/kvs/${key}`, {
    value: JSON.stringify(value),
  });
  if (r.status >= 300) {
    throw new Error(`kvPut ${collection}/${key} → ${r.status} ${r.body}`);
  }
}

export async function kvGet<T>(
  collection: string,
  key: string
): Promise<T | null> {
  const r = await request("GET", `/collections/${collection}/kvs/${key}`);
  if (r.status === 404) return null;
  const j = JSON.parse(r.body) as { ok?: boolean; value?: string };
  if (!j.ok || j.value == null) return null;
  return JSON.parse(j.value) as T;
}

export async function kvDelete(collection: string, key: string): Promise<void> {
  await request("DELETE", `/collections/${collection}/kvs/${key}`);
}

interface ScanItem {
  data?: { named?: { key?: string; value?: string } };
}

/**
 * List every entry of a KV collection via the KV-native `/scan` endpoint.
 *
 * We deliberately do NOT use `POST /query {SELECT key,value}`: in reddb 1.11.0 a SQL SELECT
 * declares the collection's model as `table`, after which KV writes are rejected with
 * `INVALID_OPERATION: collection is declared as 'table' and does not allow 'kv' operations`.
 * `/scan` returns the same rows (`items[].data.named.{key,value}`) and keeps the model `kv`.
 * (In 0.1.5 `/scan` was broken — fixed in 1.11.0, the version we now bundle.)
 */
export async function kvCount(collection: string): Promise<number> {
  const r = await request("GET", `/collections/${collection}/scan`);
  if (r.status >= 300) return 0;
  try {
    const j = JSON.parse(r.body) as { items?: ScanItem[] };
    return j.items?.length ?? 0;
  } catch {
    return 0;
  }
}

export async function kvList<T>(
  collection: string
): Promise<Array<{ key: string; value: T }>> {
  const r = await request("GET", `/collections/${collection}/scan`);
  if (r.status >= 300) return [];
  const j = JSON.parse(r.body) as { items?: ScanItem[] };
  const out: Array<{ key: string; value: T }> = [];
  for (const it of j.items ?? []) {
    const k = it.data?.named?.key;
    const v = it.data?.named?.value;
    if (k == null || v == null) continue;
    try {
      out.push({ key: k, value: JSON.parse(v) as T });
    } catch {
      /* skip malformed */
    }
  }
  return out;
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
