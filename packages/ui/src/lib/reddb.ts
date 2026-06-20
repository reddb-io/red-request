// Minimal RedDB KV client. All HTTP is proxied through the Rust `reddb_request` command
// (reqwest) — the webview's native fetch to http://127.0.0.1 is blocked as mixed content,
// and Rust gives us correct request framing for reddb 0.1.5. Values are JSON strings.
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

/** Create a KV collection (idempotent — a 400 CollectionExists is fine). */
export async function ensureKvCollection(name: string): Promise<void> {
  await request("POST", "/collections", { name, kind: "kv" });
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
