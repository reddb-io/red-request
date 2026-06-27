// Thin wrapper translating a (resolved) RequestDefinition into a recker dispatch and
// back into a serializable ResponseResult. recker is imported from its narrow subpaths
// (`recker/client`, `recker/plugins`) — importing the root barrel throws on a missing
// `raffel` package (packaging bug in 1.0.103).
import { createClient } from "recker/client";
import { inspectTLS } from "recker/utils/tls-inspector";
import {
  basicAuthPlugin,
  bearerAuthPlugin,
  apiKeyAuthPlugin,
  digestAuthPlugin,
  awsSignatureV4Plugin,
} from "recker/plugins";
import type {
  RequestDefinition,
  ResponseResult,
  AuthConfig,
  Kv,
} from "@red-request/core";
import { cookieHeader, storeSetCookies } from "./cookies.js";
import { proxiedDispatch } from "./proxy-dispatch.js";

type Plugin = unknown;
type ReckerCall = (
  url: string,
  options: Record<string, unknown>
) => Promise<ReckerResponse>;
type AnyClient = Record<string, ReckerCall>;
interface ReckerResponse {
  status: number;
  statusText: string;
  ok: boolean;
  url: string;
  headers: Headers;
  timings?: Record<string, number>;
  blob: () => Promise<Blob>;
}

const TEXTY =
  /^(text\/|application\/(json|xml|x-www-form-urlencoded|javascript|graphql|.*\+json|.*\+xml)|image\/svg)/i;

function enabled(list: Kv[]): Kv[] {
  return list.filter((kv) => kv.enabled && kv.name.trim() !== "");
}

function headerRecord(list: Kv[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of enabled(list)) out[kv.name] = kv.value;
  return out;
}

function lowerKeys(rec: Record<string, string>): Set<string> {
  return new Set(Object.keys(rec).map((k) => k.toLowerCase()));
}

function appendQuery(url: string, query: Kv[]): string {
  const params = enabled(query);
  if (params.length === 0) return url;
  const qs = params
    .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(p.value)}`)
    .join("&");
  return url + (url.includes("?") ? "&" : "?") + qs;
}

function authToPlugin(auth: AuthConfig): Plugin | null {
  switch (auth.type) {
    case "basic":
      return basicAuthPlugin({
        username: auth.username,
        password: auth.password,
      });
    case "bearer":
      return bearerAuthPlugin({ token: auth.token });
    case "apiKey":
      // recker's ApiKeyAuthOptions: `name` is the header/query field, `key` is the value.
      return apiKeyAuthPlugin({ name: auth.key, key: auth.value, in: auth.in });
    case "digest":
      return digestAuthPlugin({
        username: auth.username,
        password: auth.password,
      });
    case "awsSigV4":
      return awsSignatureV4Plugin({
        accessKeyId: auth.accessKeyId,
        secretAccessKey: auth.secretAccessKey,
        region: auth.region,
        service: auth.service,
        ...(auth.sessionToken ? { sessionToken: auth.sessionToken } : {}),
      });
    // oauth2 is handled by fetching a token first (see oauth2Token) and using it as a
    // bearer; `none` / `inherit` add no plugin.
    default:
      return null;
  }
}

function buildBody(
  def: RequestDefinition,
  headers: Record<string, string>
): Record<string, unknown> {
  const opts: Record<string, unknown> = {};
  const have = lowerKeys(headers);
  const setCT = (ct: string) => {
    if (!have.has("content-type")) headers["Content-Type"] = ct;
  };
  const body = def.body;
  switch (body.type) {
    case "json": {
      try {
        opts.json = JSON.parse(body.content || "null");
      } catch {
        opts.body = body.content;
        setCT("application/json");
      }
      break;
    }
    case "graphql": {
      let variables: unknown = {};
      try {
        variables = JSON.parse(body.variables || "{}");
      } catch {
        variables = {};
      }
      opts.json = { query: body.content, variables };
      break;
    }
    case "xml":
      opts.body = body.content;
      setCT("application/xml");
      break;
    case "form":
    case "multipart":
      opts.form = Object.fromEntries(
        enabled(body.fields).map((f) => [f.name, f.value])
      );
      break;
    case "raw":
      opts.body = body.content;
      setCT("text/plain");
      break;
    case "none":
    default:
      break;
  }
  return opts;
}

async function mapResponse(
  res: ReckerResponse,
  startedAt: number
): Promise<ResponseResult> {
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  const contentType = headers["content-type"] ?? "";
  const ab = await (await res.blob()).arrayBuffer();
  const buf = Buffer.from(new Uint8Array(ab));
  const isText = contentType === "" || TEXTY.test(contentType);
  const result: ResponseResult = {
    status: res.status,
    statusText: res.statusText ?? "",
    ok: res.ok,
    url: res.url ?? "",
    headers,
    bodyText: isText ? buf.toString("utf8") : "",
    contentType: contentType || undefined,
    size: buf.length,
    durationMs: res.timings?.total ?? Date.now() - startedAt,
    timings: res.timings,
  };
  if (!isText && buf.length > 0) result.bodyBase64 = buf.toString("base64");
  // TLS panel needs handshake details (protocol/cipher/cert/SAN). recker's HTTP
  // client surfaces only the response, so we open a parallel tls inspector
  // connection against the same origin. Cost: ~1 extra TLS handshake per
  // https request; worth it for the diagnostic value.
  if (result.url.startsWith("https://")) {
    try {
      const u = new URL(result.url);
      const info = await inspectTLS(u.hostname, u.port ? Number(u.port) : 443);
      result.meta = {
        ...(result.meta ?? {}),
        tls: {
          version: info.protocol,
          cipher: info.cipher
            ? `${info.cipher.name} (${info.cipher.version})`
            : null,
          sni: u.hostname,
          cert: {
            subject: formatDN(info.subject),
            issuer: formatDN(info.issuer),
            validFrom: info.validFrom.toISOString(),
            validTo: info.validTo.toISOString(),
            san: info.altNames ?? [],
          },
        },
      };
    } catch {
      /* inspector failed (e.g. server requires SNI we couldn't compute) —
       * leave meta.tls unset so the TLS panel shows its "metadata unavailable"
       * hint instead of pretending we know something we don't. */
    }
  }
  return result;
}

function formatDN(
  dn: Record<string, string> | string | null | undefined
): string {
  if (!dn) return "";
  if (typeof dn === "string") return dn;
  // OpenSSL-style DN: pair in display order, RFC 4514 style.
  return Object.entries(dn)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

/** Dispatch an already variable-resolved request through recker. Never throws.
 *  `jarKey` (a collection id) enables the cookie jar: stored cookies are sent and the
 *  response's Set-Cookie is absorbed. */
export async function dispatch(
  def: RequestDefinition,
  jarKey?: string
): Promise<ResponseResult> {
  // recker's HTTP/2 core can't honour a per-request proxy — route proxied requests through
  // node:http(s) with a proxy agent (real http/https/socks5/socks5h support).
  if (def.proxy?.trim()) return proxiedDispatch(def, def.proxy.trim(), jarKey);
  const startedAt = Date.now();
  const headers = headerRecord(def.headers);
  const bodyOpts = buildBody(def, headers);
  const plugins: unknown[] = [];
  const authPlugin = authToPlugin(def.auth);
  if (authPlugin) plugins.push(authPlugin);

  const url = appendQuery(def.url, def.query);
  if (jarKey) {
    const jarCookies = cookieHeader(jarKey, url);
    if (jarCookies) {
      const has = lowerKeys(headers).has("cookie");
      const existing = has
        ? (headers[
            Object.keys(headers).find((k) => k.toLowerCase() === "cookie")!
          ] ?? "")
        : "";
      headers["Cookie"] = existing ? `${existing}; ${jarCookies}` : jarCookies;
    }
  }
  const options: Record<string, unknown> = {
    headers,
    throwHttpErrors: false,
    ...bodyOpts,
  };
  if (def.timeout) options.timeout = def.timeout;
  if (def.followRedirects === false) options.followRedirects = false;
  else if (typeof def.maxRedirects === "number")
    options.maxRedirects = def.maxRedirects;
  if (def.insecure) options.insecure = true;

  try {
    const client = createClient({
      plugins,
    } as Parameters<typeof createClient>[0]) as unknown as AnyClient;
    // Use the method-specific function (post/put/patch take RequestWithBodyOptions, which
    // serializes `json`/`form`/`body`); `request()` ignores the body options.
    const call = client[def.method.toLowerCase()];
    if (typeof call !== "function") {
      throw new Error(`unsupported method: ${def.method}`);
    }
    const res = await call.call(client, url, options);
    if (jarKey) {
      const sc =
        (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
        [];
      storeSetCookies(jarKey, url, sc);
    }
    return await mapResponse(res, startedAt);
  } catch (err: unknown) {
    const e = err as {
      message?: string;
      response?: ReckerResponse;
      classification?: string;
      retriable?: boolean;
    };
    if (e.response && typeof e.response.status === "number") {
      const mapped = await mapResponse(e.response, startedAt);
      mapped.error = {
        message: e.message ?? "request failed",
        classification: e.classification,
        retriable: e.retriable,
      };
      return mapped;
    }
    return {
      status: 0,
      statusText: "",
      ok: false,
      url,
      headers: {},
      bodyText: "",
      size: 0,
      durationMs: Date.now() - startedAt,
      error: {
        message: e.message ?? String(err),
        classification: e.classification,
        retriable: e.retriable,
      },
    };
  }
}

/** OAuth2 token endpoint (form-encoded POST). Supports client_credentials, password,
 *  authorization_code (PKCE) and refresh_token grants. Returns the full token set. */
export async function oauth2Token(params: {
  grantType:
    | "client_credentials"
    | "password"
    | "authorization_code"
    | "refresh_token";
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  audience?: string;
  username?: string;
  password?: string;
  code?: string;
  codeVerifier?: string;
  redirectUri?: string;
  refreshToken?: string;
}): Promise<{
  accessToken: string;
  tokenType: string;
  expiresIn?: number;
  refreshToken?: string;
  idToken?: string;
  scope?: string;
}> {
  const form: Record<string, string> = {
    grant_type: params.grantType,
    client_id: params.clientId,
  };
  if (params.clientSecret) form.client_secret = params.clientSecret;
  if (params.scope) form.scope = params.scope;
  if (params.audience) form.audience = params.audience;
  if (params.grantType === "password") {
    form.username = params.username ?? "";
    form.password = params.password ?? "";
  } else if (params.grantType === "authorization_code") {
    form.code = params.code ?? "";
    if (params.redirectUri) form.redirect_uri = params.redirectUri;
    if (params.codeVerifier) form.code_verifier = params.codeVerifier;
  } else if (params.grantType === "refresh_token") {
    form.refresh_token = params.refreshToken ?? "";
  }
  const client = createClient({}) as unknown as AnyClient;
  const post = client.post as ReckerCall;
  const res = await post.call(client, params.tokenUrl, {
    form,
    throwHttpErrors: false,
  });
  const text = await res.blob().then((b) => b.text());
  let json: {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    id_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`token endpoint returned non-JSON (status ${res.status})`);
  }
  if (!json.access_token) {
    const detail =
      json.error_description || json.error || `status ${res.status}`;
    throw new Error(`token endpoint returned no access_token (${detail})`);
  }
  return {
    accessToken: json.access_token,
    tokenType: json.token_type ?? "Bearer",
    expiresIn: json.expires_in,
    refreshToken: json.refresh_token,
    idToken: json.id_token,
    scope: json.scope,
  };
}

/** Fetch an OIDC provider's `.well-known/openid-configuration` and map the endpoints. */
export async function oidcDiscover(params: { issuer: string }): Promise<{
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  jwksUri?: string;
  scopesSupported?: string[];
}> {
  const base = params.issuer.replace(/\/+$/, "");
  const url = `${base}/.well-known/openid-configuration`;
  const client = createClient({}) as unknown as AnyClient;
  const get = client.get as ReckerCall;
  const res = await get.call(client, url, { throwHttpErrors: false });
  const text = await res.blob().then((b) => b.text());
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error(
      `discovery endpoint returned non-JSON (status ${res.status})`
    );
  }
  const s = (k: string) =>
    typeof doc[k] === "string" ? (doc[k] as string) : undefined;
  if (!s("token_endpoint"))
    throw new Error(`no token_endpoint at ${url} (status ${res.status})`);
  return {
    issuer: s("issuer"),
    authorizationEndpoint: s("authorization_endpoint"),
    tokenEndpoint: s("token_endpoint"),
    userinfoEndpoint: s("userinfo_endpoint"),
    jwksUri: s("jwks_uri"),
    scopesSupported: Array.isArray(doc.scopes_supported)
      ? (doc.scopes_supported as string[])
      : undefined,
  };
}
