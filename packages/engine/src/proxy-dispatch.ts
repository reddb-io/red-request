// Proxied HTTP dispatch. recker's core (HTTP/2) doesn't honour a per-request proxy, so when a
// request has one we send it ourselves:
//   • http/https proxy → node:http(s) + https-proxy-agent (CONNECT-tunnels https origins).
//   • socks5/socks5h   → hand-rolled: the `socks` package opens the tunnel, then we speak
//     HTTP/1.1 over the socket (TLS-wrapped for https). This is required because Bun's compiled
//     runtime ignores socks-proxy-agent / custom socket agents and its fetch has no socks — so
//     a naive approach would silently connect direct. Verified on both node and the Bun binary.
// Covers method, headers, query, body, basic/bearer/apiKey auth, redirects, timeout, TLS-skip
// and the cookie jar. (digest/oauth2/awsSigV4 auth fall back to recker — no proxy there.)
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { Buffer } from "node:buffer";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksClient } from "socks";
// Aliases kept after the import so the probe helper below can pick http vs https
// without re-importing (require() is unavailable in the engine's ESM bundle).
const httpMod = http;
const httpsMod = https;
import type {
  RequestDefinition,
  ResponseResult,
  Kv,
  AuthConfig,
  Timings,
  ProxyProbeResult,
} from "@reddb-io/request-core";
import { cookieHeader, storeSetCookies } from "./cookies.js";

const TEXTY =
  /^(text\/|application\/(json|xml|x-www-form-urlencoded|javascript|graphql|.*\+json|.*\+xml)|image\/svg)/i;
const enabled = (l: Kv[]) => l.filter((k) => k.enabled && k.name.trim() !== "");
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function appendQuery(url: string, query: Kv[]): string {
  const ps = enabled(query);
  if (!ps.length) return url;
  const qs = ps
    .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value)}`)
    .join("&");
  return url + (url.includes("?") ? "&" : "?") + qs;
}
function headerRecord(list: Kv[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of enabled(list)) out[kv.name] = kv.value;
  return out;
}
function applyAuth(
  auth: AuthConfig,
  headers: Record<string, string>,
  url: URL
): void {
  switch (auth.type) {
    case "basic":
      headers["Authorization"] =
        `Basic ${b64(`${auth.username}:${auth.password}`)}`;
      break;
    case "bearer":
      headers["Authorization"] = `Bearer ${auth.token}`;
      break;
    case "apiKey":
      if (auth.in === "query") url.searchParams.set(auth.key, auth.value);
      else headers[auth.key] = auth.value;
      break;
  }
}
function bodyOf(def: RequestDefinition): {
  body?: string;
  contentType?: string;
} {
  const b = def.body;
  switch (b.type) {
    case "json":
      return { body: b.content, contentType: "application/json" };
    case "xml":
      return { body: b.content, contentType: "application/xml" };
    case "raw":
      return { body: b.content, contentType: "text/plain" };
    case "graphql": {
      let variables: unknown = {};
      try {
        variables = JSON.parse(b.variables || "{}");
      } catch {
        variables = {};
      }
      return {
        body: JSON.stringify({ query: b.content, variables }),
        contentType: "application/json",
      };
    }
    case "form":
      return {
        body: enabled(b.fields)
          .map(
            (f) =>
              `${encodeURIComponent(f.name)}=${encodeURIComponent(f.value)}`
          )
          .join("&"),
        contentType: "application/x-www-form-urlencoded",
      };
    default:
      return {};
  }
}
const errResult = (
  url: string,
  started: number,
  message: string
): ResponseResult => ({
  status: 0,
  statusText: "",
  ok: false,
  url,
  headers: {},
  bodyText: "",
  size: 0,
  durationMs: Date.now() - started,
  error: { message },
});

export function proxiedDispatch(
  def: RequestDefinition,
  proxyUrl: string,
  jarKey?: string
): Promise<ResponseResult> {
  let scheme = "";
  try {
    scheme = new URL(proxyUrl).protocol.replace(/:$/, "");
  } catch {
    return Promise.resolve(
      errResult(def.url, Date.now(), `invalid proxy: ${proxyUrl}`)
    );
  }
  // SOCKS must be hand-rolled (Bun's compiled runtime ignores socks-proxy-agent and its fetch
  // has no socks); http/https proxies go through node:http + HttpsProxyAgent (works on both).
  if (scheme.startsWith("socks"))
    return socksDispatch(def, proxyUrl, def.url, 0, jarKey);
  return doRequest(def, proxyUrl, def.url, 0, jarKey);
}

/**
 * Lightweight reachability check for a proxy — opens the handshake (TCP for plain,
 * CONNECT for http/https, the full SocksClient.createConnection for socks5/5h) and
 * tears the socket down without sending any bytes to the destination. Used by the
 * Proxies modal's per-row "Test" button so users can verify credentials/host before
 * wiring a profile.
 *
 * Resolves with `ok=false` + an `error` string on any failure (DNS, TCP, auth, …)
 * — never throws — so the UI can render a clean status pill.
 */
export async function probeProxy(
  proxyUrl: string,
  timeoutMs = 8_000
): Promise<ProxyProbeResult> {
  const started = Date.now();
  let u: URL;
  try {
    u = new URL(proxyUrl);
  } catch {
    return {
      ok: false,
      ms: 0,
      via: "tcp",
      error: `invalid proxy: ${proxyUrl}`,
    };
  }
  const scheme = u.protocol.replace(/:$/, "");
  if (scheme.startsWith("socks")) return probeSocks(u, timeoutMs, started);
  if (scheme === "http" || scheme === "https")
    return probeHttpConnect(u, timeoutMs, started);
  return {
    ok: false,
    ms: 0,
    via: "tcp",
    error: `unsupported proxy scheme: ${scheme}`,
  };
}

function probeHttpConnect(
  u: URL,
  timeoutMs: number,
  started: number
): Promise<ProxyProbeResult> {
  const targetHost = u.hostname || "example.com";
  const targetPort = 443; // any TLS port works for the CONNECT; we never complete the handshake.
  return new Promise<ProxyProbeResult>((resolve) => {
    const mod = u.protocol === "https:" ? httpsMod : httpMod;
    const req = mod.request({
      host: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}` },
      timeout: timeoutMs,
    });
    req.on("connect", () => {
      req.destroy();
      resolve({ ok: true, ms: Date.now() - started, via: "connect" });
    });
    req.on("error", (e: Error) =>
      resolve({
        ok: false,
        ms: Date.now() - started,
        via: "connect",
        error: e.message,
      })
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({
        ok: false,
        ms: Date.now() - started,
        via: "connect",
        error: "connect timed out",
      });
    });
    req.end();
  });
}

async function probeSocks(
  u: URL,
  timeoutMs: number,
  started: number
): Promise<ProxyProbeResult> {
  try {
    const port = Number(u.port) || 1080;
    // SocksClient does the full greeting+auth+CONNECT handshake. We aim at the proxy
    // itself (host:port) so it doesn't matter whether the destination exists — only
    // that the proxy is alive and authenticates us correctly.
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: u.hostname,
        port,
        type: 5,
        userId: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
      },
      command: "connect",
      destination: { host: u.hostname, port },
      timeout: timeoutMs,
    });
    socket.destroy();
    return { ok: true, ms: Date.now() - started, via: "socks" };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - started,
      via: "socks",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function agentFor(proxyUrl: string): http.Agent {
  return new HttpsProxyAgent(proxyUrl);
}

function doRequest(
  def: RequestDefinition,
  proxyUrl: string,
  currentUrl: string,
  redirects: number,
  jarKey?: string
): Promise<ResponseResult> {
  const started = Date.now();
  return new Promise<ResponseResult>((resolve) => {
    let u: URL;
    try {
      u = new URL(appendQuery(currentUrl, def.query));
    } catch {
      return resolve(errResult(currentUrl, started, "invalid URL"));
    }
    const headers = headerRecord(def.headers);
    applyAuth(def.auth, headers, u);
    if (jarKey) {
      const ck = cookieHeader(jarKey, u.toString());
      if (ck)
        headers["Cookie"] = headers["Cookie"]
          ? `${headers["Cookie"]}; ${ck}`
          : ck;
    }
    const { body, contentType } = bodyOf(def);
    const hasCT = Object.keys(headers).some(
      (k) => k.toLowerCase() === "content-type"
    );
    if (contentType && !hasCT) headers["Content-Type"] = contentType;
    if (body != null)
      headers["Content-Length"] = String(Buffer.byteLength(body));

    let agent: http.Agent;
    try {
      agent = agentFor(proxyUrl);
    } catch {
      return resolve(
        errResult(u.toString(), started, `invalid proxy: ${proxyUrl}`)
      );
    }
    const mod = u.protocol === "https:" ? https : http;
    // Captures in ms-since-request-started. Undefined = not yet measured.
    const t: Partial<Timings> = {};
    // mark a one-shot listener for the FIRST secureConnect we observe on this run
    // (the agent keeps the proxy socket warm — we only want to charge the TLS handshake
    // when it actually happens, not on every keep-alive reuse).
    let seenSecureConnect = false;
    const startedAt = started;
    const stamp = () => Date.now() - startedAt;
    const req = mod.request(
      u,
      {
        method: def.method,
        headers,
        agent,
        rejectUnauthorized: !def.insecure,
        timeout: def.timeout || 30_000,
      },
      (res) => {
        // firstByte is when the origin's response headers arrived (TTFB).
        // For an HTTPS-via-proxy: the proxy+origin TLS handshakes happen on the
        // same socket before this fires, so secureConnect already updated t.proxyTls.
        t.firstByte = stamp();
        // If the agent tunneled before handing us the socket (HttpsProxyAgent), we
        // never saw a `secureConnect` event — surface that TLS time as the `tls` phase
        // so the timings bar still shows it.
        if (t.tls == null && t.proxyTls != null) t.tls = t.proxyTls;
        const status = res.statusCode ?? 0;
        const loc = res.headers.location;
        if (
          def.followRedirects !== false &&
          loc &&
          [301, 302, 303, 307, 308].includes(status) &&
          redirects < (def.maxRedirects ?? 5)
        ) {
          if (jarKey)
            storeSetCookies(
              jarKey,
              u.toString(),
              res.headers["set-cookie"] ?? []
            );
          res.resume();
          const next = new URL(loc, u).toString();
          const method = status === 303 ? "GET" : def.method;
          resolve(
            doRequest(
              { ...def, method, query: [] },
              proxyUrl,
              next,
              redirects + 1,
              jarKey
            )
          );
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (jarKey)
            storeSetCookies(
              jarKey,
              u.toString(),
              res.headers["set-cookie"] ?? []
            );
          const buf = Buffer.concat(chunks);
          const ct = String(res.headers["content-type"] ?? "");
          const isText = ct === "" || TEXTY.test(ct);
          const respHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers))
            respHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
          const total = Date.now() - started;
          t.content = total;
          t.total = total;
          const result: ResponseResult = {
            status,
            statusText: res.statusMessage ?? "",
            ok: status >= 200 && status < 300,
            url: u.toString(),
            headers: respHeaders,
            bodyText: isText ? buf.toString("utf8") : "",
            contentType: ct || undefined,
            size: buf.length,
            durationMs: total,
            timings: t as Timings,
          };
          if (!isText && buf.length > 0)
            result.bodyBase64 = buf.toString("base64");
          resolve(result);
        });
      }
    );
    req.on("error", (e) =>
      resolve(errResult(u.toString(), started, e.message))
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(errResult(u.toString(), started, "request timed out"));
    });
    // node fires `socket` when the agent hands us a socket. We grab a `proxyConnect`
    // reading here — for a fresh dial the socket may already be `readyState: open`
    // (https-proxy-agent CONNECT-tunnels before handing the socket off), so the
    // lookup/connect/secureConnect events often DON'T fire on the node:http side.
    // For other paths (socks, plain http over proxy) the events still fire normally.
    req.on("socket", (sock) => {
      const s = sock as net.Socket & { isTLSSocket?: boolean };
      const handed = stamp();
      // For HTTPS-via-proxy the tunnel is already done by the time we get here.
      // We charge `proxyConnect` once the socket is ready (open or tunneled) — that
      // captures the TCP + CONNECT portion whether we observed it as events or not.
      if (t.proxyConnect == null) t.proxyConnect = handed;
      s.on("lookup", () => {
        if (t.dns == null) t.dns = stamp();
      });
      s.on("connect", () => {
        // If we didn't see socket.readyState===open yet, this is a fresh TCP dial.
        if (t.tcp == null) t.tcp = stamp();
      });
      s.on("secureConnect", () => {
        // First TLS handshake on the tunneled socket (only meaningful if the agent
        // hadn't already tunneled before handing the socket to us).
        if (!seenSecureConnect) {
          seenSecureConnect = true;
          t.proxyTls = stamp();
        }
      });
    });
    if (body != null) req.write(body);
    req.end();
  });
}

// --- SOCKS5 / SOCKS5h: tunnel via the `socks` package, then speak HTTP/1.1 over the socket
// (Bun-compatible — it can't inject a custom socket into node:http). --------------------------
async function socksDispatch(
  def: RequestDefinition,
  proxyUrl: string,
  currentUrl: string,
  redirects: number,
  jarKey?: string
): Promise<ResponseResult> {
  const started = Date.now();
  let u: URL;
  let pu: URL;
  try {
    u = new URL(appendQuery(currentUrl, def.query));
    pu = new URL(proxyUrl);
  } catch {
    return errResult(currentUrl, started, "invalid URL");
  }
  const isHttps = u.protocol === "https:";
  const port = Number(u.port) || (isHttps ? 443 : 80);
  const timeout = def.timeout || 30_000;

  const headers = headerRecord(def.headers);
  applyAuth(def.auth, headers, u);
  headers["Host"] = u.host;
  headers["Connection"] = "close";
  headers["Accept-Encoding"] = "identity"; // keep the body un-compressed for simple parsing
  if (jarKey) {
    const ck = cookieHeader(jarKey, u.toString());
    if (ck)
      headers["Cookie"] = headers["Cookie"]
        ? `${headers["Cookie"]}; ${ck}`
        : ck;
  }
  const { body, contentType } = bodyOf(def);
  if (
    contentType &&
    !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")
  )
    headers["Content-Type"] = contentType;
  if (body != null) headers["Content-Length"] = String(Buffer.byteLength(body));

  let raw: Buffer;
  // timings collected along the way; we attach them to the parsed response below.
  const t: Partial<Timings> = {};
  const stamp = () => Date.now() - started;
  try {
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: pu.hostname,
        port: Number(pu.port) || 1080,
        type: 5,
        userId: pu.username ? decodeURIComponent(pu.username) : undefined,
        password: pu.password ? decodeURIComponent(pu.password) : undefined,
      },
      command: "connect",
      destination: { host: u.hostname, port },
      timeout,
    });
    // Socks handshake (greeting + auth + CONNECT) is complete — that's `proxyConnect`.
    t.proxyConnect = stamp();
    t.tcp = stamp();

    const sock: net.Socket | tls.TLSSocket = isHttps
      ? await new Promise<tls.TLSSocket>((res, rej) => {
          const startTls = Date.now() - started;
          const t2 = tls.connect(
            {
              socket,
              servername: u.hostname,
              ALPNProtocols: ["http/1.1"],
              rejectUnauthorized: !def.insecure,
            },
            () => {
              // For socks the agent doesn't do this TLS for us — we measure it here.
              const now = Date.now() - started;
              t.proxyTls = now;
              t.tls = now;
              res(t2);
            }
          );
          t2.on("error", rej);
        })
      : socket;

    let reqText = `${def.method} ${u.pathname}${u.search} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(headers)) reqText += `${k}: ${v}\r\n`;
    reqText += "\r\n";
    sock.write(reqText);
    if (body != null) sock.write(body);

    raw = await new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      sock.on("data", (c) => chunks.push(c));
      sock.on("end", () => resolve(Buffer.concat(chunks)));
      sock.on("error", () => resolve(Buffer.concat(chunks)));
      sock.setTimeout(timeout, () => {
        sock.destroy();
        resolve(Buffer.concat(chunks));
      });
    });
  } catch (e) {
    return errResult(
      u.toString(),
      started,
      e instanceof Error ? e.message : String(e)
    );
  }

  return parseSocksResponse(
    raw,
    u.toString(),
    started,
    def,
    proxyUrl,
    t,
    redirects,
    jarKey
  );
}

function dechunk(buf: Buffer): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf("\r\n", i);
    if (nl === -1) break;
    const size = parseInt(buf.subarray(i, nl).toString("latin1").trim(), 16);
    if (Number.isNaN(size) || size === 0) break;
    const start = nl + 2;
    out.push(Buffer.from(buf.subarray(start, start + size)));
    i = start + size + 2;
  }
  return Buffer.concat(out);
}

function parseSocksResponse(
  raw: Buffer,
  url: string,
  started: number,
  def: RequestDefinition,
  proxyUrl: string,
  t: Partial<Timings>,
  redirects: number,
  jarKey?: string
): Promise<ResponseResult> | ResponseResult {
  const sep = raw.indexOf("\r\n\r\n");
  if (sep === -1) return errResult(url, started, "malformed proxy response");
  const lines = raw.subarray(0, sep).toString("latin1").split("\r\n");
  let body: Buffer = Buffer.from(raw.subarray(sep + 4));
  const m = (lines[0] ?? "").match(/^HTTP\/\d(?:\.\d)?\s+(\d+)\s*(.*)$/);
  const status = m ? Number(m[1]) : 0;
  const headers: Record<string, string> = {};
  const setCookies: string[] = [];
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === "set-cookie") setCookies.push(v);
    headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
  }
  if ((headers["transfer-encoding"] ?? "").toLowerCase().includes("chunked"))
    body = dechunk(body);
  if (jarKey) storeSetCookies(jarKey, url, setCookies);

  const loc = headers["location"];
  if (
    def.followRedirects !== false &&
    loc &&
    [301, 302, 303, 307, 308].includes(status) &&
    redirects < (def.maxRedirects ?? 5)
  ) {
    const next = new URL(loc, url).toString();
    const method = status === 303 ? "GET" : def.method;
    return socksDispatch(
      { ...def, method, query: [] },
      proxyUrl,
      next,
      redirects + 1,
      jarKey
    );
  }

  // TTFB = when the response headers came off the wire (we read them as a whole here,
  // so use the first-byte time recorded at the head of the buffer as a proxy for it).
  const total = Date.now() - started;
  t.firstByte = t.firstByte ?? (sep >= 0 ? Date.now() - started : undefined);
  t.content = total;
  t.total = total;

  const ct = headers["content-type"] ?? "";
  const isText = ct === "" || TEXTY.test(ct);
  const result: ResponseResult = {
    status,
    statusText: m?.[2] ?? "",
    ok: status >= 200 && status < 300,
    url,
    headers,
    bodyText: isText ? body.toString("utf8") : "",
    contentType: ct || undefined,
    size: body.length,
    durationMs: total,
    timings: t as Timings,
  };
  if (!isText && body.length > 0) result.bodyBase64 = body.toString("base64");
  return result;
}
