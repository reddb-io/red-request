// RedDB client. Every operation is RQL (RedDB's SQL) sent through the Rust `reddb_rql`
// command, which runs `red connect` — the native conduit shared by the local embedded
// server and remote `reds://` connections. KV ops use the native `KV PUT/GET/DELETE` /
// `LIST KV` verbs (model stays `kv`); values are JSON strings. Keys are single-quoted
// (so dots/colons are literal) and `'` is escaped as `''`.
import { invoke } from "@tauri-apps/api/core";

interface HttpReply {
  status: number;
  body: string;
}

/** Escape a single-quoted RQL string literal. */
const esc = (s: string) => s.replace(/'/g, "''");
/** A `collection.'key'` reference — the key quoted so dots/colons stay literal. */
const kvRef = (collection: string, key: string) =>
  `${collection}.'${esc(key)}'`;

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
  const c = await rql(`CREATE KV ${name}`);
  if (!c.ok && !/already exists/i.test(c.error ?? ""))
    throw new Error(`CREATE KV ${name}: ${c.error}`);
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
  const r = await rql(`LIST KV ${collection}`);
  return r.ok ? r.records.length : 0;
}

/** Every entry of a KV collection (`LIST KV`). Values are parsed back from their JSON. */
export async function kvList<T>(
  collection: string
): Promise<Array<{ key: string; value: T }>> {
  const r = await rql(`LIST KV ${collection}`);
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
