// Collection repository — backed by the embedded RedDB store (KV collections).
//
//   rr_collections   key=<colId>            → CollectionFile
//   rr_requests      key=<colId>.<reqId>    → RequestDefinition
//   rr_environments  key=<colId>.<envSlug>  → StoredEnvironment (sealed secrets)
//
// Keys use `.` as separator; collection/request ids and env slugs are URL-safe slugs.
import {
  collectionFileSchema,
  requestDefinitionSchema,
  storedEnvironmentSchema,
  newRequest,
  type CollectionFile,
  type RequestDefinition,
  type StoredEnvironment,
  type LoadedCollection,
} from "@red-requester/core";
import * as db from "./reddb";

export const COL = "rr_collections";
export const REQ = "rr_requests";
export const ENV = "rr_environments";

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
const envKey = (colId: string, name: string) => `${colId}.${slugify(name)}`;
const ownedBy = (colId: string, key: string) => key.startsWith(`${colId}.`);

export async function ensureStore(): Promise<void> {
  await db.ensureKvCollection(COL);
  await db.ensureKvCollection(REQ);
  await db.ensureKvCollection(ENV);
}

export async function loadAll(): Promise<LoadedCollection[]> {
  const [cols, reqs, envs] = await Promise.all([
    db.kvList<CollectionFile>(COL),
    db.kvList<RequestDefinition>(REQ),
    db.kvList<StoredEnvironment>(ENV),
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
    const environments = envs
      .filter((e) => ownedBy(colId, e.key))
      .map((e) => storedEnvironmentSchema.parse(e.value));
    return { id: colId, collection, requests, environments };
  });
}

export const saveCollectionMeta = (colId: string, c: CollectionFile) =>
  db.kvPut(COL, colId, c);

export const saveRequest = (colId: string, req: RequestDefinition) =>
  db.kvPut(REQ, reqKey(colId, req.id), req);

export const deleteRequest = (colId: string, reqId: string) =>
  db.kvDelete(REQ, reqKey(colId, reqId));

export const saveEnvironment = (colId: string, env: StoredEnvironment) =>
  db.kvPut(ENV, envKey(colId, env.name), env);

export const deleteEnvironment = (colId: string, name: string) =>
  db.kvDelete(ENV, envKey(colId, name));

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
    headers: [{ name: "X-Demo", value: "red-requester", enabled: true }],
    body: { type: "json", content: '{\n  "name": "ada"\n}', fields: [] },
  });
  await saveEnvironment(
    colId,
    storedEnvironmentSchema.parse({
      name: "dev",
      vars: { host: "httpbingo.org" },
      secrets: {},
    })
  );
}
