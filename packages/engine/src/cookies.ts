// A minimal in-memory cookie jar, keyed by collection id. Enabled per-collection, it lets
// Set-Cookie from one response flow into the Cookie header of later requests in the same
// collection (browser-like session). In-memory only — cleared on engine restart or on demand.
interface Cookie {
  name: string;
  value: string;
  domain: string; // host, no leading dot
  path: string;
  expires?: number; // epoch ms; undefined = session cookie
}

const jars = new Map<string, Cookie[]>();

const domainMatch = (host: string, cookieDomain: string): boolean => {
  const d = cookieDomain.replace(/^\./, "").toLowerCase();
  const h = host.toLowerCase();
  return h === d || h.endsWith("." + d);
};
const pathMatch = (reqPath: string, cookiePath: string): boolean =>
  reqPath === cookiePath ||
  reqPath.startsWith(
    cookiePath.endsWith("/") ? cookiePath : cookiePath + "/"
  ) ||
  cookiePath === "/";

function parseSetCookie(sc: string, u: URL): Cookie | null {
  const parts = sc.split(";");
  const first = (parts.shift() ?? "").trim();
  const eq = first.indexOf("=");
  if (eq < 1) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  let domain = u.hostname;
  let path = "/";
  let expires: number | undefined;
  for (const p of parts) {
    const i = p.indexOf("=");
    const key = (i === -1 ? p : p.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? "" : p.slice(i + 1).trim();
    if (key === "domain" && val) domain = val.replace(/^\./, "");
    else if (key === "path" && val) path = val;
    else if (key === "max-age") {
      const s = Number(val);
      if (!Number.isNaN(s)) expires = Date.now() + s * 1000;
    } else if (key === "expires" && expires === undefined) {
      const t = Date.parse(val);
      if (!Number.isNaN(t)) expires = t;
    }
  }
  return { name, value, domain, path, expires };
}

/** Cookie header value for a request, or null if the jar has no matching cookies. */
export function cookieHeader(jarKey: string, url: string): string | null {
  const list = jars.get(jarKey);
  if (!list?.length) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const now = Date.now();
  const out = new Map<string, string>();
  for (const c of list) {
    if (c.expires && c.expires <= now) continue;
    if (
      domainMatch(u.hostname, c.domain) &&
      pathMatch(u.pathname || "/", c.path)
    )
      out.set(c.name, c.value);
  }
  if (!out.size) return null;
  return [...out].map(([n, v]) => `${n}=${v}`).join("; ");
}

/** Absorb a response's Set-Cookie headers into the jar. */
export function storeSetCookies(
  jarKey: string,
  url: string,
  setCookies: string[]
): void {
  if (!setCookies?.length) return;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  const list = jars.get(jarKey) ?? [];
  for (const sc of setCookies) {
    const c = parseSetCookie(sc, u);
    if (!c) continue;
    const i = list.findIndex(
      (x) => x.name === c.name && x.domain === c.domain && x.path === c.path
    );
    if (i !== -1) list.splice(i, 1);
    if (c.expires && c.expires <= Date.now()) continue; // expired → just delete
    list.push(c);
  }
  jars.set(jarKey, list);
}

export function clearJar(jarKey: string): void {
  jars.delete(jarKey);
}
