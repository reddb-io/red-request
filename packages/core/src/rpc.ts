import { z } from "zod";

/**
 * NDJSON-RPC contract spoken over the sidecar's stdio. One JSON object per line.
 * The Rust shell writes requests to the engine's stdin and reads responses /
 * notifications from its stdout.
 */

export const rpcRequestSchema = z.object({
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof rpcRequestSchema>;

export const rpcResponseSchema = z.union([
  z.object({
    id: z.union([z.number(), z.string()]),
    result: z.unknown(),
  }),
  z.object({
    id: z.union([z.number(), z.string()]),
    error: z.object({
      message: z.string(),
      data: z.unknown().optional(),
    }),
  }),
]);
export type RpcResponse = z.infer<typeof rpcResponseSchema>;

/** Out-of-band stream message (SSE chunks, WS frames, progress) — no `id`. */
export const rpcNotificationSchema = z.object({
  stream: z.string(),
  event: z.string(),
  data: z.unknown().optional(),
});
export type RpcNotification = z.infer<typeof rpcNotificationSchema>;

/** Engine method names. Phase-1 methods first; later ones declared for forward-compat. */
export const ENGINE_METHODS = {
  httpSend: "http.send",
  oauth2Token: "oauth2.token",
  collectionDryRun: "collection.dryRun",
  runnerRun: "runner.run",
  metaReckerVersion: "meta.reckerVersion",
  // declared for later phases:
  wsOpen: "ws.open",
  wsSend: "ws.send",
  wsClose: "ws.close",
  sseOpen: "sse.open",
  sseClose: "sse.close",
  graphqlSend: "graphql.send",
  sseStream: "sse.stream",
  importParse: "import.parse",
  codegen: "codegen",
} as const;
export type EngineMethod = (typeof ENGINE_METHODS)[keyof typeof ENGINE_METHODS];
