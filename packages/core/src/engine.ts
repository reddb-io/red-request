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
});
export type HttpSendParams = z.infer<typeof httpSendParamsSchema>;

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

export const oauth2TokenParamsSchema = z.object({
  grantType: z
    .enum(["client_credentials", "password"])
    .default("client_credentials"),
  tokenUrl: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  scope: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
});
export type Oauth2TokenParams = z.infer<typeof oauth2TokenParamsSchema>;

export const oauth2TokenResultSchema = z.object({
  accessToken: z.string(),
  tokenType: z.string().default("Bearer"),
  expiresIn: z.number().optional(),
});
export type Oauth2TokenResult = z.infer<typeof oauth2TokenResultSchema>;
