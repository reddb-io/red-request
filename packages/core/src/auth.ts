import { z } from "zod";

/**
 * Auth methods. The first release wires the six methods recker exposes as plugins and
 * that we verified end-to-end against recker@1.0.103:
 *   basicAuthPlugin, bearerAuthPlugin, apiKeyAuthPlugin, digestAuthPlugin,
 *   oauth2Plugin, awsSignatureV4Plugin.
 * `inherit` defers to the folder/collection auth. Further methods (oidc, okta, ...) are
 * available in recker/plugins and will be added in later phases.
 *
 * Any string field may contain `{{var}}` placeholders — resolved before dispatch, so
 * secrets live in the keychain and never in the YAML.
 */
export const authConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("inherit") }),
  z.object({
    type: z.literal("basic"),
    username: z.string().default(""),
    password: z.string().default(""),
  }),
  z.object({
    type: z.literal("bearer"),
    token: z.string().default(""),
  }),
  z.object({
    type: z.literal("apiKey"),
    key: z.string().default(""),
    value: z.string().default(""),
    in: z.enum(["header", "query"]).default("header"),
  }),
  z.object({
    type: z.literal("digest"),
    username: z.string().default(""),
    password: z.string().default(""),
  }),
  z.object({
    type: z.literal("oauth2"),
    grantType: z
      .enum(["client_credentials", "authorization_code", "password"])
      .default("client_credentials"),
    tokenUrl: z.string().default(""),
    clientId: z.string().default(""),
    clientSecret: z.string().default(""),
    scope: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  }),
  z.object({
    type: z.literal("awsSigV4"),
    accessKeyId: z.string().default(""),
    secretAccessKey: z.string().default(""),
    region: z.string().default("us-east-1"),
    service: z.string().default("execute-api"),
    sessionToken: z.string().optional(),
  }),
]);

export type AuthConfig = z.infer<typeof authConfigSchema>;
export type AuthType = AuthConfig["type"];

/** Auth types selectable in the request editor (excludes `inherit`, which is implicit). */
export const SELECTABLE_AUTH_TYPES: AuthType[] = [
  "none",
  "basic",
  "bearer",
  "apiKey",
  "digest",
  "oauth2",
  "awsSigV4",
];
