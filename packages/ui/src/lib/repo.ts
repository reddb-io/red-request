// Collection repository — bridges the on-disk YAML layout to validated core objects.
//
//   <root>/<collectionId>/collection.yaml
//   <root>/<collectionId>/requests/<requestId>.yaml
//   <root>/<collectionId>/environments/<name>.yaml
import { parse, stringify } from "yaml";
import {
  collectionFileSchema,
  environmentFileSchema,
  requestDefinitionSchema,
  newRequest,
  type CollectionFile,
  type EnvironmentFile,
  type RequestDefinition,
  type LoadedCollection,
} from "@red-requester/core";
import * as fs from "./fs";

const join = (...parts: string[]) => parts.join("/");

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "item"
  );
}

export async function loadCollection(
  folder: string
): Promise<LoadedCollection | null> {
  const entries = await fs.listDir(folder);
  const hasCollection = entries.some((e) => e.name === "collection.yaml");
  if (!hasCollection) return null;

  const collection = collectionFileSchema.parse(
    parse(await fs.readText(join(folder, "collection.yaml"))) ?? {}
  );

  const requests: RequestDefinition[] = [];
  const reqDir = join(folder, "requests");
  for (const e of await fs.listDir(reqDir)) {
    if (e.is_dir || !e.name.endsWith(".yaml")) continue;
    requests.push(
      requestDefinitionSchema.parse(parse(await fs.readText(e.path)))
    );
  }

  const environments: EnvironmentFile[] = [];
  const envDir = join(folder, "environments");
  for (const e of await fs.listDir(envDir)) {
    if (e.is_dir || !e.name.endsWith(".yaml")) continue;
    environments.push(
      environmentFileSchema.parse(parse(await fs.readText(e.path)))
    );
  }

  // Honor the collection's declared order, appending any unlisted requests.
  requests.sort((a, b) => {
    const ia = collection.order.indexOf(a.id);
    const ib = collection.order.indexOf(b.id);
    return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
  });

  return { path: folder, collection, requests, environments };
}

export async function loadAll(): Promise<LoadedCollection[]> {
  const root = await fs.collectionsRoot();
  const out: LoadedCollection[] = [];
  for (const entry of await fs.listDir(root)) {
    if (!entry.is_dir) continue;
    const loaded = await loadCollection(entry.path);
    if (loaded) out.push(loaded);
  }
  return out;
}

export async function saveCollection(
  folder: string,
  collection: CollectionFile
): Promise<void> {
  await fs.writeText(join(folder, "collection.yaml"), stringify(collection));
}

export async function saveRequest(
  folder: string,
  req: RequestDefinition
): Promise<void> {
  await fs.mkdirp(join(folder, "requests"));
  await fs.writeText(
    join(folder, "requests", `${req.id}.yaml`),
    stringify(req)
  );
}

export async function deleteRequest(folder: string, id: string): Promise<void> {
  await fs.remove(join(folder, "requests", `${id}.yaml`));
}

export async function saveEnvironment(
  folder: string,
  env: EnvironmentFile
): Promise<void> {
  await fs.mkdirp(join(folder, "environments"));
  await fs.writeText(
    join(folder, "environments", `${slugify(env.name)}.yaml`),
    stringify(env)
  );
}

/** Seed a runnable example collection on first launch so there's something to send. */
export async function ensureSample(): Promise<void> {
  const root = await fs.collectionsRoot();
  const existing = await fs.listDir(root);
  if (existing.some((e) => e.is_dir)) return;

  const folder = join(root, "sample-httpbingo");
  const collection: CollectionFile = collectionFileSchema.parse({
    name: "Sample · httpbingo",
    description: "A starter collection you can run immediately.",
    baseUrl: "https://httpbingo.org",
    vars: { host: "httpbingo.org" },
    auth: { type: "none" },
    order: ["get-anything", "post-json"],
  });
  await saveCollection(folder, collection);

  const get: RequestDefinition = {
    ...newRequest("get-anything"),
    name: "GET anything",
    method: "GET",
    url: "https://{{host}}/get",
    query: [{ name: "hello", value: "world", enabled: true }],
  };
  const post: RequestDefinition = {
    ...newRequest("post-json"),
    name: "POST json",
    method: "POST",
    url: "https://{{host}}/post",
    headers: [{ name: "X-Demo", value: "red-requester", enabled: true }],
    body: { type: "json", content: '{\n  "name": "ada"\n}', fields: [] },
  };
  await saveRequest(folder, get);
  await saveRequest(folder, post);

  await saveEnvironment(
    folder,
    environmentFileSchema.parse({
      name: "dev",
      vars: { host: "httpbingo.org" },
      secretRefs: [],
    })
  );
}
