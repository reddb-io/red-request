import { z } from "zod";

export const projectSyncEventKindSchema = z.enum([
  "collection.saved",
  "collection.deleted",
  "request.saved",
  "request.deleted",
  "environment.saved",
  "environment.renamed",
  "environment.deleted",
  "environment.reordered",
  "secret.saved",
  "secret.deleted",
  "settings.saved",
  "globals.saved",
  "network.saved",
]);
export type ProjectSyncEventKind = z.infer<typeof projectSyncEventKindSchema>;

export const projectSyncEntitySchema = z.object({
  type: z.enum([
    "collection",
    "request",
    "environment",
    "secret",
    "settings",
    "globals",
    "network",
  ]),
  id: z.string(),
  parentId: z.string().optional(),
  name: z.string().optional(),
});
export type ProjectSyncEntity = z.infer<typeof projectSyncEntitySchema>;

export const projectSyncEventSchema = z.object({
  v: z.literal(1),
  id: z.string(),
  ts: z.number().int().nonnegative(),
  source: z.literal("red-request"),
  clientId: z.string(),
  kind: projectSyncEventKindSchema,
  entity: projectSyncEntitySchema,
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type ProjectSyncEvent = z.infer<typeof projectSyncEventSchema>;
