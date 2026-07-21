import { z } from "zod";
import { authConfigSchema, type AuthConfig } from "./auth.js";
import {
  kvSchema,
  requestDefinitionSchema,
  type Kv,
  type RequestDefinition,
} from "./request.js";
import { timingsSchema } from "./response.js";

export const collectionRootItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request"), id: z.string() }),
  z.object({ kind: z.literal("folder"), name: z.string() }),
]);
export type CollectionRootItem = z.infer<typeof collectionRootItemSchema>;

const folderConfigObjectSchema = z.object({
  name: z.string(),
  auth: authConfigSchema.default({ type: "inherit" }),
  headers: z.array(kvSchema).default([]),
  vars: z.record(z.string(), z.string()).default({}),
});

export const folderConfigSchema = z.preprocess(
  (value) =>
    typeof value === "string"
      ? {
          name: value,
          auth: { type: "inherit" },
          headers: [],
          vars: {},
        }
      : value,
  folderConfigObjectSchema
);
export type FolderConfig = z.infer<typeof folderConfigSchema>;

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
  /** Folders for grouping requests (incl. empty folders) and folder-level scope config. */
  folders: z.array(folderConfigSchema).default([]),
  /** Mixed order of root requests and folders. Empty means legacy order: requests, then folders. */
  rootOrder: z.array(collectionRootItemSchema).default([]),
  /** Persist Set-Cookie across this collection's requests (browser-like session). */
  cookieJar: z.boolean().default(false),
  /** Default project profile applied to requests that don't pick one (empty = none). */
  defaultProfileId: z.string().default(""),
  /** Header rows inherited by every request in the collection unless the request overrides them. */
  defaultHeaders: z.array(kvSchema).default([]),
});
export type CollectionFile = z.infer<typeof collectionFileSchema>;

const rootItemKey = (item: CollectionRootItem): string =>
  item.kind === "request" ? `request:${item.id}` : `folder:${item.name}`;

export const folderName = (folder: FolderConfig | string): string =>
  typeof folder === "string" ? folder : folder.name;

export type InheritedHeaderSource = "collection" | "folder";
export type InheritedHeaderRow = Kv & {
  source: InheritedHeaderSource;
  disabled: boolean;
};

export const headerIdentity = (name: string): string =>
  name.trim().toLowerCase();

export function findFolderConfig(
  collection: CollectionFile,
  name: string
): FolderConfig | undefined {
  return collection.folders.find((folder) => folderName(folder) === name);
}

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
      (name): name is string =>
        !!name &&
        !collection.folders.some((folder) => folderName(folder) === name)
    )
    .sort((left, right) => left.localeCompare(right));
  const folderNames = new Set([
    ...collection.folders.map(folderName),
    ...extraFolderNames,
  ]);
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
  for (const folder of collection.folders)
    append({ kind: "folder", name: folderName(folder) });
  for (const name of extraFolderNames) append({ kind: "folder", name });
  return resolved;
}

export function mergeCollectionDefaultHeaders(
  collectionHeaders: Kv[],
  requestHeaders: Kv[]
): Kv[] {
  const requestNames = new Set(
    requestHeaders
      .map((header) => header.name.trim().toLowerCase())
      .filter(Boolean)
  );
  const inherited = collectionHeaders.filter((header) => {
    const name = header.name.trim().toLowerCase();
    return name && !requestNames.has(name);
  });
  return [
    ...inherited.map((header) => ({ ...header })),
    ...requestHeaders.map((header) => ({ ...header })),
  ];
}

const authHeaderNames = (auth: AuthConfig): string[] => {
  switch (auth.type) {
    case "basic":
    case "bearer":
    case "digest":
    case "oauth2":
    case "awsSigV4":
      return ["authorization"];
    case "apiKey":
      return auth.in === "header" && auth.key.trim()
        ? [auth.key.trim().toLowerCase()]
        : [];
    default:
      return [];
  }
};

export function resolveEffectiveAuth(
  collection: CollectionFile,
  request: RequestDefinition
): AuthConfig {
  if (request.auth.type !== "inherit") return { ...request.auth };
  const folder = request.folder
    ? findFolderConfig(collection, request.folder)
    : undefined;
  if (folder?.auth.type && folder.auth.type !== "inherit")
    return { ...folder.auth };
  return { ...collection.auth };
}

export function mergeScopedDefaultHeaders(
  collection: CollectionFile,
  request: RequestDefinition
): Kv[] {
  return [
    ...inheritedHeadersForRequest(collection, request)
      .filter((header) => !header.disabled)
      .map(({ source, disabled, ...header }) => header),
    ...request.headers.map((header) => ({ ...header })),
  ];
}

export function inheritedHeadersForRequest(
  collection: CollectionFile,
  request: RequestDefinition
): InheritedHeaderRow[] {
  const folder = request.folder
    ? findFolderConfig(collection, request.folder)
    : undefined;
  const disabled = new Set(
    (request.disabledInheritedHeaders ?? []).map(headerIdentity).filter(Boolean)
  );
  const requestNames = new Set(
    request.headers.map((header) => headerIdentity(header.name)).filter(Boolean)
  );
  const folderNames = new Set(
    (folder?.headers ?? [])
      .map((header) => headerIdentity(header.name))
      .filter(Boolean)
  );

  const rows: InheritedHeaderRow[] = [];
  for (const header of collection.defaultHeaders) {
    const name = headerIdentity(header.name);
    if (!name || folderNames.has(name) || requestNames.has(name)) continue;
    rows.push({
      ...header,
      source: "collection",
      disabled: disabled.has(name),
    });
  }
  for (const header of folder?.headers ?? []) {
    const name = headerIdentity(header.name);
    if (!name || requestNames.has(name)) continue;
    rows.push({ ...header, source: "folder", disabled: disabled.has(name) });
  }
  return rows;
}

export function resolveScopedRequest(
  collection: CollectionFile,
  request: RequestDefinition
): RequestDefinition {
  const auth = resolveEffectiveAuth(collection, request);
  const requestHeaderNames = new Set(
    request.headers
      .map((header) => header.name.trim().toLowerCase())
      .filter(Boolean)
  );
  const authNames = new Set(authHeaderNames(auth));
  const headers = mergeScopedDefaultHeaders(collection, request).filter(
    (header) => {
      const name = header.name.trim().toLowerCase();
      return !name || requestHeaderNames.has(name) || !authNames.has(name);
    }
  );
  return {
    ...request,
    auth: [...authNames].some((name) => requestHeaderNames.has(name))
      ? { type: "none" }
      : auth,
    headers,
  };
}

export function resolveScopedVariables(
  collection: CollectionFile,
  request: RequestDefinition,
  lowerScopes: {
    environment?: Record<string, string>;
    secrets?: Record<string, string>;
  } = {}
): Record<string, string> {
  const folder = request.folder
    ? findFolderConfig(collection, request.folder)
    : undefined;
  const requestVars = request.vars ?? {};
  return Object.assign(
    {},
    lowerScopes.secrets ?? {},
    lowerScopes.environment ?? {},
    collection.vars,
    folder?.vars ?? {},
    requestVars
  );
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
