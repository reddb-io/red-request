import { z } from "zod";
import { requestDefinitionSchema } from "./request.js";
import { responseResultSchema } from "./response.js";

/** Params/results for the engine RPC methods used in the first release. */

export const httpSendParamsSchema = z.object({
  request: requestDefinitionSchema,
  /**
   * Flat, already-merged variable map (request → folder → collection → environment →
   * secret). The engine resolves `{{var}}` placeholders with this before dispatching.
   */
  variables: z.record(z.string(), z.string()).default({}),
  /** When set, persist/apply cookies under this jar key (collection id). */
  cookieJarKey: z.string().optional(),
});
export type HttpSendParams = z.infer<typeof httpSendParamsSchema>;

export const cookiesClearParamsSchema = z.object({ key: z.string() });
export type CookiesClearParams = z.infer<typeof cookiesClearParamsSchema>;

// --- gRPC -------------------------------------------------------------------
export const grpcMethodsParamsSchema = z.object({ proto: z.string() });
export type GrpcMethodsParams = z.infer<typeof grpcMethodsParamsSchema>;

export const grpcMethodSchema = z.object({
  name: z.string(),
  requestStream: z.boolean(),
  responseStream: z.boolean(),
  requestType: z.string().optional(),
  skeleton: z.string().default("{}"),
});
export const grpcServiceSchema = z.object({
  name: z.string(),
  methods: z.array(grpcMethodSchema),
});
export type GrpcMethod = z.infer<typeof grpcMethodSchema>;
export type GrpcService = z.infer<typeof grpcServiceSchema>;
export const grpcMethodsResultSchema = z.object({
  services: z.array(grpcServiceSchema).default([]),
  error: z.string().optional(),
});
export type GrpcMethodsResult = z.infer<typeof grpcMethodsResultSchema>;

export const grpcCallParamsSchema = z.object({
  request: requestDefinitionSchema,
  variables: z.record(z.string(), z.string()).default({}),
});
export type GrpcCallParams = z.infer<typeof grpcCallParamsSchema>;

export const scriptTestSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  error: z.string().optional(),
});
export type ScriptTest = z.infer<typeof scriptTestSchema>;

/** Output of the pre/post-response script run. */
export const scriptResultSchema = z.object({
  logs: z.array(z.string()).default([]),
  tests: z.array(scriptTestSchema).default([]),
  /** Variables the script set (post-response) — the UI persists these to the env. */
  varChanges: z.record(z.string(), z.string()).default({}),
  error: z.string().optional(),
});
export type ScriptResult = z.infer<typeof scriptResultSchema>;

export const httpSendResultSchema = z.object({
  response: responseResultSchema,
  /** Placeholders that could not be resolved (UI surfaces these as a warning). */
  unresolved: z.array(z.string()).default([]),
  /** The fully-resolved, about-to-be-sent URL — handy for the UI/address bar. */
  effectiveUrl: z.string().default(""),
  scriptResult: scriptResultSchema.optional(),
});
export type HttpSendResult = z.infer<typeof httpSendResultSchema>;

// --- websocket (streaming over engine://stream notifications) --------------

export const wsOpenParamsSchema = z.object({
  /** Client-chosen connection id; stream events carry it back so the UI can correlate. */
  id: z.string(),
  request: requestDefinitionSchema,
  variables: z.record(z.string(), z.string()).default({}),
});
export type WsOpenParams = z.infer<typeof wsOpenParamsSchema>;

export const wsSendParamsSchema = z.object({
  id: z.string(),
  data: z.string(),
});
export type WsSendParams = z.infer<typeof wsSendParamsSchema>;

export const wsCloseParamsSchema = z.object({ id: z.string() });
export type WsCloseParams = z.infer<typeof wsCloseParamsSchema>;

export const oauth2TokenParamsSchema = z.object({
  grantType: z
    .enum([
      "client_credentials",
      "password",
      "authorization_code",
      "refresh_token",
    ])
    .default("client_credentials"),
  tokenUrl: z.string(),
  clientId: z.string(),
  clientSecret: z.string().default(""),
  scope: z.string().optional(),
  audience: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  // authorization_code exchange
  code: z.string().optional(),
  codeVerifier: z.string().optional(),
  redirectUri: z.string().optional(),
  // refresh_token grant
  refreshToken: z.string().optional(),
});
export type Oauth2TokenParams = z.infer<typeof oauth2TokenParamsSchema>;

export const oauth2TokenResultSchema = z.object({
  accessToken: z.string(),
  tokenType: z.string().default("Bearer"),
  expiresIn: z.number().optional(),
  refreshToken: z.string().optional(),
  idToken: z.string().optional(),
  scope: z.string().optional(),
});
export type Oauth2TokenResult = z.infer<typeof oauth2TokenResultSchema>;

/** OIDC discovery: fetch `<issuer>/.well-known/openid-configuration`. */
export const oidcDiscoverParamsSchema = z.object({ issuer: z.string() });
export type OidcDiscoverParams = z.infer<typeof oidcDiscoverParamsSchema>;

export const oidcDiscoverResultSchema = z.object({
  issuer: z.string().optional(),
  authorizationEndpoint: z.string().optional(),
  tokenEndpoint: z.string().optional(),
  userinfoEndpoint: z.string().optional(),
  jwksUri: z.string().optional(),
  scopesSupported: z.array(z.string()).optional(),
});
export type OidcDiscoverResult = z.infer<typeof oidcDiscoverResultSchema>;

// --- runner / loops ---------------------------------------------------------

const runnerVars = z.record(z.string(), z.string()).default({});

/** Params for `runner.run`, discriminated on `mode`. */
export const runnerParamsSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("repeat"),
    request: requestDefinitionSchema,
    count: z.number().int().min(1).max(1000).default(1),
    variables: runnerVars,
  }),
  z.object({
    mode: z.literal("data"),
    request: requestDefinitionSchema,
    dataset: z.array(z.record(z.string(), z.string())).default([]),
    variables: runnerVars,
  }),
  z.object({
    mode: z.literal("flow"),
    requests: z.array(requestDefinitionSchema).default([]),
    variables: runnerVars,
  }),
]);
export type RunnerParams = z.infer<typeof runnerParamsSchema>;

export const runIterationSchema = z.object({
  index: z.number(),
  label: z.string(),
  reqId: z.string(),
  reqName: z.string(),
  method: z.string(),
  url: z.string(),
  response: responseResultSchema,
  scriptResult: scriptResultSchema.optional(),
});
export type RunIteration = z.infer<typeof runIterationSchema>;

export const runnerResultSchema = z.object({
  iterations: z.array(runIterationSchema).default([]),
  aggregate: z.object({
    total: z.number(),
    okCount: z.number(),
    passed: z.number(),
    failed: z.number(),
    avgMs: z.number(),
  }),
});
export type RunnerResult = z.infer<typeof runnerResultSchema>;
