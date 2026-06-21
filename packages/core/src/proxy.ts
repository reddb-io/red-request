import { z } from "zod";
import { kvSchema } from "./request.js";

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

/** A user profile / identity bound to a request: a User-Agent, extra headers, and a proxy. */
export const profileSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  userAgent: z.string().default(""),
  headers: z.array(kvSchema).default([]),
  /** id of a proxy in the same collection (or empty for a direct connection). */
  proxyId: z.string().default(""),
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

/** A small catalog of current browser User-Agents to pick from when building a profile. */
export const USER_AGENTS: { name: string; value: string }[] = [
  {
    name: "Chrome · Windows",
    value:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
  {
    name: "Chrome · macOS",
    value:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
  {
    name: "Chrome · Linux",
    value:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
  {
    name: "Firefox · Windows",
    value:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  },
  {
    name: "Firefox · macOS",
    value:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
  },
  {
    name: "Safari · macOS",
    value:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  },
  {
    name: "Edge · Windows",
    value:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  },
  {
    name: "Safari · iPhone",
    value:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  },
  {
    name: "Chrome · Android",
    value:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  },
  {
    name: "curl",
    value: "curl/8.11.0",
  },
];
