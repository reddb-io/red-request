import { z } from "zod";
import { authConfigSchema } from "./auth.js";
import { requestDefinitionSchema, type RequestDefinition } from "./request.js";
import { timingsSchema } from "./response.js";

export const collectionRootItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request"), id: z.string() }),
  z.object({ kind: z.literal("folder"), name: z.string() }),
]);
export type CollectionRootItem = z.infer<typeof collectionRootItemSchema>;

/**
 * `collection.yaml` at the root of a collection folder. Variables and auth defined here
 * are inherited by every request unless the request overrides them.
 */
export const collectionFileSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  baseUrl: z.string().optional(),
  vars: z.record(z.string(), z.string()).default({}),
  auth: authConfigSchema.default({ type: "none" }),
  /** Ordered request ids (file slugs) for stable sidebar ordering. */
  order: z.array(z.string()).default([]),
  /** Folder names for grouping requests (incl. empty folders). */
  folders: z.array(z.string()).default([]),
  /** Mixed order of root requests and folders. Empty means legacy order: requests, then folders. */
  rootOrder: z.array(collectionRootItemSchema).default([]),
  /** Persist Set-Cookie across this collection's requests (browser-like session). */
  cookieJar: z.boolean().default(false),
  /** Default project profile applied to requests that don't pick one (empty = none). */
  defaultProfileId: z.string().default(""),
});
export type CollectionFile = z.infer<typeof collectionFileSchema>;

const rootItemKey = (item: CollectionRootItem): string =>
  item.kind === "request" ? `request:${item.id}` : `folder:${item.name}`;

/**
 * Return a complete, de-duplicated root tree order. Older collections do not have
 * `rootOrder`; they retain the historical layout (root requests followed by folders)
 * until the first structural edit persists the explicit mixed order.
 */
export function resolveCollectionRootOrder(
  collection: CollectionFile,
  requests: RequestDefinition[]
): CollectionRootItem[] {
  const rootRequestIds = new Set(
    requests.filter((request) => !request.folder).map((request) => request.id)
  );
  const extraFolderNames = requests
    .map((request) => request.folder)
    .filter(
      (name): name is string => !!name && !collection.folders.includes(name)
    )
    .sort((left, right) => left.localeCompare(right));
  const folderNames = new Set([...collection.folders, ...extraFolderNames]);
  const resolved: CollectionRootItem[] = [];
  const seen = new Set<string>();

  const append = (item: CollectionRootItem) => {
    const valid =
      item.kind === "request"
        ? rootRequestIds.has(item.id)
        : folderNames.has(item.name);
    const key = rootItemKey(item);
    if (!valid || seen.has(key)) return;
    seen.add(key);
    resolved.push(item);
  };

  for (const item of collection.rootOrder) append(item);
  for (const id of collection.order) append({ kind: "request", id });
  for (const request of requests) append({ kind: "request", id: request.id });
  for (const name of collection.folders) append({ kind: "folder", name });
  for (const name of extraFolderNames) append({ kind: "folder", name });
  return resolved;
}

/**
 * YAML export shape of an environment (the git artifact). Plain `vars` are written;
 * secret *values* are NEVER exported — only their names, as `secretRefs`.
 */
export const environmentFileSchema = z.object({
  name: z.string(),
  vars: z.record(z.string(), z.string()).default({}),
  secretRefs: z.array(z.string()).default([]),
});
export type EnvironmentFile = z.infer<typeof environmentFileSchema>;

/**
 * A secret value sealed app-side (AES-256-GCM) before it is stored in the `.rdb`.
 * The master key lives in the OS keychain; the `.rdb` only ever holds ciphertext.
 */
export const sealedSecretSchema = z.object({
  iv: z.string(), // base64 nonce
  ct: z.string(), // base64 ciphertext (+ GCM tag)
});
export type SealedSecret = z.infer<typeof sealedSecretSchema>;

/**
 * Native RedDB secret reference used by red-request's live store. The plaintext
 * lives in RedDB's vault; configs only keep this reference metadata.
 */
export const nativeSecretRefSchema = z.object({
  ref: z.string(),
  vault: z.string().default("red_request"),
  configKey: z.string(),
  missing: z.boolean().default(false),
});
export type NativeSecretRef = z.infer<typeof nativeSecretRefSchema>;

export const storedSecretSchema = z.union([
  nativeSecretRefSchema,
  sealedSecretSchema,
]);
export type StoredSecret = z.infer<typeof storedSecretSchema>;

/**
 * Runtime/persisted environment. New stores keep native RedDB secret references;
 * the sealed-secret arm is accepted only so old rr_environments KV rows can be
 * migrated without losing values.
 */
export const storedEnvironmentSchema = z.object({
  name: z.string(),
  vars: z.record(z.string(), z.string()).default({}),
  secrets: z.record(z.string(), storedSecretSchema).default({}),
});
export type StoredEnvironment = z.infer<typeof storedEnvironmentSchema>;

/** Derive the git-safe YAML export (names only) from a stored environment. */
export function environmentToFile(env: StoredEnvironment): EnvironmentFile {
  return {
    name: env.name,
    vars: env.vars,
    secretRefs: Object.keys(env.secrets),
  };
}

/** A request file (`requests/<slug>.yaml`) is exactly a RequestDefinition. */
export const requestFileSchema = requestDefinitionSchema;

/** One recorded run (for the project dashboard). Stored in the `rr_history` document collection. */
export const historyEntrySchema = z.object({
  id: z.string(),
  reqId: z.string(),
  collectionId: z.string(),
  name: z.string(),
  method: z.string(),
  url: z.string(),
  ts: z.number(),
  status: z.number(),
  ok: z.boolean(),
  durationMs: z.number(),
  size: z.number().default(0),
  timings: timingsSchema.optional(),
  testsPassed: z.number().default(0),
  testsFailed: z.number().default(0),
  env: z.string().optional(),
  profileId: z.string().optional(),
  profileName: z.string().optional(),
  proxyId: z.string().optional(),
  proxyName: z.string().optional(),
  proxyUrl: z.string().optional(),
  /** Stable local client id for grouping team runs by dispatcher installation. */
  dispatcherClientId: z.string().optional(),
  /** Best-effort local machine name for team-run grouping. */
  dispatcherHost: z.string().optional(),
  /** Best-effort local OS/user name for team-run grouping. */
  dispatcherUser: z.string().optional(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

/**
 * In-memory view the UI works with: a collection plus its requests + environments.
 * `id` is the collection's key in the RedDB store (also its export folder name).
 */
export const loadedCollectionSchema = z.object({
  id: z.string(),
  collection: collectionFileSchema,
  requests: z.array(requestDefinitionSchema).default([]),
  environments: z.array(storedEnvironmentSchema).default([]),
});
export type LoadedCollection = z.infer<typeof loadedCollectionSchema>;
