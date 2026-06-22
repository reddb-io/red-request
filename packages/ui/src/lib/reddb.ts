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
