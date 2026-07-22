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
    /** OIDC: when set, authorize/token endpoints are discovered from
     *  `<issuer>/.well-known/openid-configuration`. */
    issuer: z.string().default(""),
    /** Interactive (authorization_code) authorize endpoint. */
    authorizeUrl: z.string().default(""),
    tokenUrl: z.string().default(""),
    clientId: z.string().default(""),
    /** Optional — a public client using PKCE needs none. */
    clientSecret: z.string().default(""),
    scope: z.string().default(""),
    audience: z.string().default(""),
    /** PKCE (S256) — on by default; required for public clients. */
    usePkce: z.boolean().default(true),
    /** Where the IdP redirects after login (authorization_code). */
    redirect: z.enum(["loopback", "deeplink"]).default("loopback"),
    /** password grant */
    username: z.string().default(""),
    password: z.string().default(""),
    /** Extra query params appended to the authorize URL (e.g. prompt, login_hint). */
    extraParams: z
      .array(
        z.object({
          name: z.string(),
          value: z.string().default(""),
          enabled: z.boolean().default(true),
        })
      )
      .default([]),
  }),
  z.object({
    type: z.literal("tokenRequest"),
    requestId: z.string().default(""),
    refreshRequestId: z.string().default(""),
    accessTokenPath: z.string().default("access_token"),
    refreshTokenPath: z.string().default("refresh_token"),
    accessTokenSecretName: z.string().default("access_token"),
    refreshTokenSecretName: z.string().default("refresh_token"),
    expiryResponsePath: z.string().default(""),
    manualTtlSeconds: z.number().int().nonnegative().default(0),
    renewalMarginSeconds: z.number().int().nonnegative().default(30),
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
  "tokenRequest",
  "awsSigV4",
];
