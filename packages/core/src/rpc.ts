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
  oidcDiscover: "oidc.discover",
  collectionDryRun: "collection.dryRun",
  runnerRun: "runner.run",
  metaReckerVersion: "meta.reckerVersion",
  // declared for later phases:
  wsOpen: "ws.open",
  wsSend: "ws.send",
  wsClose: "ws.close",
  sseOpen: "sse.open",
  sseClose: "sse.close",
  cookiesClear: "cookies.clear",
  grpcMethods: "grpc.methods",
  grpcCall: "grpc.call",
  graphqlSend: "graphql.send",
  sseStream: "sse.stream",
  importParse: "import.parse",
  codegen: "codegen",
  proxyProbe: "proxy.probe",
} as const;
export type EngineMethod = (typeof ENGINE_METHODS)[keyof typeof ENGINE_METHODS];

/**
 * Engine-side schemas for the `proxy.probe` RPC — used by the Proxies modal to
 * verify a proxy is reachable without sending a real user request through it.
 * Opens the TCP/SOCKS handshake (or HTTP CONNECT for an http(s) proxy) and
 * reports success/failure + the wall-clock time, without ever touching the
 * destination host.
 */
export const proxyProbeParamsSchema = z.object({
  /** Fully-resolved proxy URL (no `{{vars}}` expected): `scheme://[user:pass@]host:port`. */
  proxyUrl: z.string(),
  /** Hard cap on the whole probe (ms). Defaults to 8s in the handler. */
  timeoutMs: z.number().int().positive().optional(),
});
export type ProxyProbeParams = z.infer<typeof proxyProbeParamsSchema>;

export const proxyProbeResultSchema = z.object({
  ok: z.boolean(),
  /** Wall-clock for the handshake (ms). 0 if the probe failed before timing. */
  ms: z.number(),
  /** What we actually verified — surfaces in the UI as the green label. */
  via: z.enum(["tcp", "connect", "socks"]),
  /** Error message when `ok` is false. */
  error: z.string().optional(),
});
export type ProxyProbeResult = z.infer<typeof proxyProbeResultSchema>;
