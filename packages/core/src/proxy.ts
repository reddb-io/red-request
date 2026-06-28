import { z } from "zod";
import { kvSchema } from "./request.js";
export { USER_AGENTS } from "./constants.js";

/** A reusable, named proxy. Fields may contain `{{vars}}` (host/port/user/pass), resolved at
 *  send-time — so a password can be a sealed secret like `{{PROXY_PASS}}`. */
export const proxySchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  type: z.enum(["http", "https", "socks5", "socks5h"]).default("http"),
  host: z.string().default(""),
  /** Port as a string so it can hold a `{{var}}`. */
  port: z.string().default(""),
  username: z.string().default(""),
  password: z.string().default(""),
});
export type Proxy = z.infer<typeof proxySchema>;

/** A user profile / identity bound to a request: a User-Agent, extra headers, a proxy, and cookie state. */
export const profileSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  userAgent: z.string().default(""),
  headers: z.array(kvSchema).default([]),
  /** id of a proxy in the same collection (or empty for a direct connection). */
  proxyId: z.string().default(""),
  /** Persist/apply Set-Cookie under this profile's identity instead of the collection jar. */
  cookieJar: z.boolean().default(false),
});
export type Profile = z.infer<typeof profileSchema>;

/** Project-level network settings: the shared pool of proxies + user profiles. Lives in the
 *  project's store (not in a collection's git YAML), so credentials aren't committed. */
export const networkSettingsSchema = z.object({
  proxies: z.array(proxySchema).default([]),
  profiles: z.array(profileSchema).default([]),
});
export type NetworkSettings = z.infer<typeof networkSettingsSchema>;

/**
 * Build a proxy URL `type://[user:pass@]host:port`. Values are kept verbatim (may hold
 * `{{vars}}`); the engine resolves the placeholders and parses the URL before dispatch.
 */
export function proxyToUrl(p: Proxy): string {
  const auth = p.username ? `${p.username}:${p.password}@` : "";
  return `${p.type}://${auth}${p.host}:${p.port}`;
}
