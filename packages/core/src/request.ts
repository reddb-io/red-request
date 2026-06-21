import { z } from "zod";
import { authConfigSchema } from "./auth.js";

export const httpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
export type HttpMethod = z.infer<typeof httpMethodSchema>;

/** A header / query-param entry. `enabled: false` keeps it in the file but skips sending. */
export const kvSchema = z.object({
  name: z.string(),
  value: z.string().default(""),
  enabled: z.boolean().default(true),
});
export type Kv = z.infer<typeof kvSchema>;

export const bodyTypeSchema = z.enum([
  "none",
  "json",
  "raw",
  "form",
  "multipart",
  "xml",
  "graphql",
]);
export type BodyType = z.infer<typeof bodyTypeSchema>;

export const requestBodySchema = z.object({
  type: bodyTypeSchema.default("none"),
  /** Raw content (JSON text, raw text, XML, GraphQL query). */
  content: z.string().default(""),
  /** Used when type is `form` / `multipart`. */
  fields: z.array(kvSchema).default([]),
  /** GraphQL variables (JSON text), only when type is `graphql`. */
  variables: z.string().optional(),
});
export type RequestBody = z.infer<typeof requestBodySchema>;

export const retrySchema = z.object({
  maxAttempts: z.number().int().min(0).default(0),
  backoff: z.enum(["linear", "exponential"]).default("exponential"),
});
export type RetryConfig = z.infer<typeof retrySchema>;

/** Pre-request / post-response scripts (JS, run in the engine sandbox). */
export const scriptsSchema = z.object({
  preRequest: z.string().default(""),
  postResponse: z.string().default(""),
});
export type Scripts = z.infer<typeof scriptsSchema>;

/** Request protocol. `http` is the default; the rest use `net` config below. */
export const requestKindSchema = z.enum([
  "http",
  "ws",
  "sse",
  "grpc",
  "tcp",
  "udp",
  "ping",
  "whois",
  "dns",
]);
export type RequestKind = z.infer<typeof requestKindSchema>;

export const dnsRecordTypeSchema = z.enum([
  "A",
  "AAAA",
  "MX",
  "TXT",
  "NS",
  "CNAME",
  "SOA",
  "SRV",
  "CAA",
]);
export type DnsRecordType = z.infer<typeof dnsRecordTypeSchema>;

/** Params for non-HTTP kinds. `host` doubles as the domain/name for whois/dns. */
export const netConfigSchema = z.object({
  host: z.string().default(""),
  port: z.number().int().min(0).max(65535).default(0),
  payload: z.string().default(""),
  waitResponse: z.boolean().default(true),
  recordType: dnsRecordTypeSchema.default("A"),
  count: z.number().int().min(1).max(50).default(4),
  timeoutMs: z.number().int().min(100).max(60000).default(5000),
});
export type NetConfig = z.infer<typeof netConfigSchema>;

/** A saved response snapshot attached to a request (for docs / quick reference / mocking). */
export const savedExampleSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.number().default(0),
  statusText: z.string().default(""),
  contentType: z.string().optional(),
  bodyText: z.string().default(""),
  savedAt: z.number().default(0),
});
export type SavedExample = z.infer<typeof savedExampleSchema>;

/** gRPC config (kind === "grpc"). The server address lives in `url` (host:port). */
export const grpcConfigSchema = z.object({
  proto: z.string().default(""),
  service: z.string().default(""),
  method: z.string().default(""),
  message: z.string().default("{}"),
  plaintext: z.boolean().default(true),
  metadata: z.array(kvSchema).default([]),
});
export type GrpcConfig = z.infer<typeof grpcConfigSchema>;

/**
 * A single request — serialized one-per-file under `requests/<slug>.yaml`.
 * Mirrors the shape recker's RequestOptions expects, kept transport-agnostic and
 * fully serializable so it round-trips through YAML and the NDJSON-RPC bridge.
 */
export const requestDefinitionSchema = z.object({
  id: z.string(),
  name: z.string().default("New Request"),
  /** Folder this request lives in (a name; "" = collection root). */
  folder: z.string().default(""),
  kind: requestKindSchema.default("http"),
  method: httpMethodSchema.default("GET"),
  url: z.string().default(""),
  net: netConfigSchema.default({
    host: "",
    port: 0,
    payload: "",
    waitResponse: true,
    recordType: "A",
    count: 4,
    timeoutMs: 5000,
  }),
  headers: z.array(kvSchema).default([]),
  query: z.array(kvSchema).default([]),
  /** Positional path params (`:name` segments in the URL). */
  pathParams: z.array(kvSchema).default([]),
  body: requestBodySchema.default({ type: "none", content: "", fields: [] }),
  auth: authConfigSchema.default({ type: "inherit" }),
  scripts: scriptsSchema.default({ preRequest: "", postResponse: "" }),
  timeout: z.number().int().positive().optional(),
  /** Network behaviour (HTTP). */
  followRedirects: z.boolean().default(true),
  maxRedirects: z.number().int().min(0).max(50).default(5),
  /** Skip TLS certificate verification (self-signed / dev endpoints). */
  insecure: z.boolean().default(false),
  /** Route through an HTTP/HTTPS/SOCKS proxy (e.g. http://127.0.0.1:8080). */
  proxy: z.string().optional(),
  /** id of a collection profile (User-Agent + headers + proxy) to apply at send-time. */
  profileId: z.string().default(""),
  retry: retrySchema.optional(),
  /** gRPC config — only when kind is `grpc`. */
  grpc: grpcConfigSchema.default({
    proto: "",
    service: "",
    method: "",
    message: "{}",
    plaintext: true,
    metadata: [],
  }),
  /** Saved response snapshots (docs / mocking) — versioned with the request. */
  examples: z.array(savedExampleSchema).default([]),
  /** Optional recker preset name (e.g. "github", "openai") applied as a base. */
  presetName: z.string().optional(),
});
export type RequestDefinition = z.infer<typeof requestDefinitionSchema>;

export function newRequest(id: string): RequestDefinition {
  return requestDefinitionSchema.parse({ id });
}
