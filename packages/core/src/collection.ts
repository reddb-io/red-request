import { z } from "zod";
import { authConfigSchema } from "./auth.js";
import { requestDefinitionSchema } from "./request.js";

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
});
export type CollectionFile = z.infer<typeof collectionFileSchema>;

/**
 * `environments/<name>.yaml`. Plain `vars` are stored in the file; `secretRefs` name
 * values kept in the OS keychain — they are NEVER written to YAML.
 */
export const environmentFileSchema = z.object({
  name: z.string(),
  vars: z.record(z.string(), z.string()).default({}),
  secretRefs: z.array(z.string()).default([]),
});
export type EnvironmentFile = z.infer<typeof environmentFileSchema>;

/** A request file (`requests/<slug>.yaml`) is exactly a RequestDefinition. */
export const requestFileSchema = requestDefinitionSchema;

/** In-memory view the UI works with: a collection plus its loaded requests + envs. */
export const loadedCollectionSchema = z.object({
  /** Absolute path of the collection folder. */
  path: z.string(),
  collection: collectionFileSchema,
  requests: z.array(requestDefinitionSchema).default([]),
  environments: z.array(environmentFileSchema).default([]),
});
export type LoadedCollection = z.infer<typeof loadedCollectionSchema>;
