// Thin wrapper translating a (resolved) RequestDefinition into a recker dispatch and
// back into a serializable ResponseResult. recker is imported from its narrow subpaths
// (`recker/client`, `recker/plugins`) — importing the root barrel throws on a missing
// `raffel` package (packaging bug in 1.0.103).
import { createClient } from "recker/client";
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
  return result;
}

/** Dispatch an already variable-resolved request through recker. Never throws. */
export async function dispatch(
  def: RequestDefinition
): Promise<ResponseResult> {
  const startedAt = Date.now();
  const headers = headerRecord(def.headers);
  const bodyOpts = buildBody(def, headers);
  const plugins: unknown[] = [];
  const authPlugin = authToPlugin(def.auth);
  if (authPlugin) plugins.push(authPlugin);

  const url = appendQuery(def.url, def.query);
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
  if (def.proxy?.trim()) options.proxy = def.proxy.trim();

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

/** OAuth2 client-credentials / password grant → access token (form-encoded POST). */
export async function oauth2Token(params: {
  grantType: "client_credentials" | "password";
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  username?: string;
  password?: string;
}): Promise<{ accessToken: string; tokenType: string; expiresIn?: number }> {
  const form: Record<string, string> = {
    grant_type: params.grantType,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  };
  if (params.scope) form.scope = params.scope;
  if (params.grantType === "password") {
    form.username = params.username ?? "";
    form.password = params.password ?? "";
  }
  const client = createClient({}) as unknown as AnyClient;
  const post = client.post as ReckerCall;
  const res = await post.call(client, params.tokenUrl, {
    form,
    throwHttpErrors: false,
  });
  const text = await res.blob().then((b) => b.text());
  const json = JSON.parse(text) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    throw new Error(
      `token endpoint returned no access_token (status ${res.status})`
    );
  }
  return {
    accessToken: json.access_token,
    tokenType: json.token_type ?? "Bearer",
    expiresIn: json.expires_in,
  };
}
