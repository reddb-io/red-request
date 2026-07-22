// Generate a runnable code snippet from an HTTP request — curl / HTTPie / JS fetch / axios /
// Python requests / Go / recker CLI. Pass an already-resolved RequestDefinition (so {{vars}} are real).
import type { RequestDefinition, Kv } from "./request.js";
import type { AuthConfig } from "./auth.js";

export type SnippetLang =
  "curl" | "httpie" | "fetch" | "axios" | "python" | "go" | "recker";

export const SNIPPET_LANGS: { id: SnippetLang; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "httpie", label: "HTTPie" },
  { id: "fetch", label: "JS · fetch" },
  { id: "axios", label: "JS · axios" },
  { id: "python", label: "Python · requests" },
  { id: "go", label: "Go" },
  { id: "recker", label: "recker CLI (rek)" },
];

interface HttpModel {
  method: string;
  url: string;
  headers: { name: string; value: string }[];
  body: string | null; // serialized body text (or null)
  contentType: string | null;
}

const b64 = (s: string) =>
  typeof btoa !== "undefined"
    ? btoa(s)
    : // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Buffer.from(s, "utf8").toString("base64");

const enabled = (list: Kv[]) => list.filter((k) => k.enabled && k.name.trim());

/** Apply auth onto headers / url (the common schemes; signed ones get a note header). */
function applyAuth(
  auth: AuthConfig,
  headers: { name: string; value: string }[],
  url: URL
): void {
  switch (auth.type) {
    case "basic":
      headers.push({
        name: "Authorization",
        value: `Basic ${b64(`${auth.username}:${auth.password}`)}`,
      });
      break;
    case "bearer":
      headers.push({ name: "Authorization", value: `Bearer ${auth.token}` });
      break;
    case "apiKey":
      if (auth.in === "query") url.searchParams.set(auth.key, auth.value);
      else headers.push({ name: auth.key, value: auth.value });
      break;
    case "digest":
    case "oauth2":
    case "tokenRequest":
    case "awsSigV4":
      headers.push({
        name: "X-RR-Auth",
        value: `${auth.type} (signed at send-time — not shown)`,
      });
      break;
  }
}

function bodyText(req: RequestDefinition): {
  body: string | null;
  contentType: string | null;
} {
  const b = req.body;
  switch (b.type) {
    case "json":
      return { body: b.content, contentType: "application/json" };
    case "xml":
      return { body: b.content, contentType: "application/xml" };
    case "raw":
      return { body: b.content, contentType: "text/plain" };
    case "graphql":
      return {
        body: JSON.stringify({
          query: b.content,
          variables: safeJson(b.variables),
        }),
        contentType: "application/json",
      };
    case "form":
      return {
        body: enabled(b.fields)
          .map((f) => `${enc(f.name)}=${enc(f.value)}`)
          .join("&"),
        contentType: "application/x-www-form-urlencoded",
      };
    default:
      return { body: null, contentType: null };
  }
}

const enc = encodeURIComponent;
const safeJson = (s?: string) => {
  if (!s?.trim()) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

function buildModel(req: RequestDefinition): HttpModel {
  const url = new URL(
    req.url || "http://localhost",
    req.url?.startsWith("http") ? undefined : "http://localhost"
  );
  for (const q of enabled(req.query)) url.searchParams.append(q.name, q.value);

  const headers = enabled(req.headers).map((h) => ({
    name: h.name,
    value: h.value,
  }));
  applyAuth(req.auth, headers, url);

  const { body, contentType } = bodyText(req);
  if (
    contentType &&
    !headers.some((h) => h.name.toLowerCase() === "content-type")
  )
    headers.push({ name: "Content-Type", value: contentType });

  return {
    method: req.method,
    url: url.toString(),
    headers,
    body,
    contentType,
  };
}

// ---------------------------------------------------------------------------
// emitters
// ---------------------------------------------------------------------------
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`; // single-quote for shells
const dq = (s: string) => JSON.stringify(s);

function curl(m: HttpModel): string {
  const lines = [`curl -X ${m.method} ${sq(m.url)}`];
  for (const h of m.headers) lines.push(`  -H ${sq(`${h.name}: ${h.value}`)}`);
  if (m.body != null) lines.push(`  --data ${sq(m.body)}`);
  return lines.join(" \\\n");
}

function httpie(m: HttpModel): string {
  const parts = [`http ${m.method} ${sq(m.url)}`];
  for (const h of m.headers) parts.push(sq(`${h.name}:${h.value}`));
  let s = parts.join(" ");
  if (m.body != null) s += `\\\n  <<< ${sq(m.body)}`;
  return s;
}

function fetch(m: HttpModel): string {
  const headers = Object.fromEntries(m.headers.map((h) => [h.name, h.value]));
  const opts: Record<string, unknown> = { method: m.method };
  if (m.headers.length) opts.headers = headers;
  if (m.body != null) opts.body = m.body;
  return `const res = await fetch(${dq(m.url)}, ${JSON.stringify(opts, null, 2)});\nconst data = await res.json();\nconsole.log(data);`;
}

function axios(m: HttpModel): string {
  const cfg: Record<string, unknown> = {
    method: m.method.toLowerCase(),
    url: m.url,
  };
  if (m.headers.length)
    cfg.headers = Object.fromEntries(m.headers.map((h) => [h.name, h.value]));
  if (m.body != null)
    cfg.data = m.contentType?.includes("json")
      ? (safeJson(m.body) ?? m.body)
      : m.body;
  return `import axios from "axios";\n\nconst { data } = await axios(${JSON.stringify(cfg, null, 2)});\nconsole.log(data);`;
}

function python(m: HttpModel): string {
  const headers = m.headers.length ? `headers=${pyDict(m.headers)}, ` : "";
  let dataArg = "";
  if (m.body != null) {
    dataArg = m.contentType?.includes("json")
      ? `json=${m.body || "{}"}, `
      : `data=${pyStr(m.body)}, `;
  }
  return `import requests\n\nres = requests.request(${pyStr(m.method)}, ${pyStr(m.url)}, ${headers}${dataArg})\nprint(res.status_code, res.json())`;
}

function go(m: HttpModel): string {
  const body = m.body != null ? `strings.NewReader(${dq(m.body)})` : "nil";
  const hdrs = m.headers
    .map((h) => `\treq.Header.Set(${dq(h.name)}, ${dq(h.value)})`)
    .join("\n");
  return `package main

import (
\t"io"
\t"net/http"
\t"strings"
)

func main() {
\treq, _ := http.NewRequest(${dq(m.method)}, ${dq(m.url)}, ${body})
${hdrs}
\tres, _ := http.DefaultClient.Do(req)
\tdefer res.Body.Close()
\tb, _ := io.ReadAll(res.Body)
\tprintln(string(b))
}`;
}

/**
 * recker CLI (the `rek` binary) — curl replacement with better DX.
 * `rek <url>` does GET by default; explicit method via positional arg.
 * Headers: `-H 'Key: Value'`. Body: `--json '{...}'` or `-d '<text>'`.
 * Auth: `-u user:pass` for basic, `-H 'Authorization: Bearer …'` otherwise.
 * Install with `npm install -g recker` (see https://forattini-dev.github.io/recker).
 */
function recker(m: HttpModel): string {
  // Start by lifting basic-auth out of the Authorization header so we can
  // render it as `-u user:pass` (friendlier copy-paste than base64). The
  // base64 decode must happen in the same environment where the snippet
  // is shown (browser / Node / Bun), so use the universal atob.
  const headers = [...m.headers];
  const flags: string[] = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    if (
      h.name.toLowerCase() === "authorization" &&
      h.value.startsWith("Basic ")
    ) {
      try {
        const decoded = atob(h.value.slice("Basic ".length).trim());
        flags.push(`-u ${sq(decoded)}`);
        continue; // skip emitting the original Authorization header
      } catch {
        /* malformed base64 — fall through and emit the header as-is */
      }
    }
    flags.push(`-H ${sq(`${h.name}: ${h.value}`)}`);
  }
  if (m.body != null) {
    if (m.contentType?.includes("json")) flags.push(`--json ${sq(m.body)}`);
    else flags.push(`-d ${sq(m.body)}`);
  }
  // GET is the default verb — only emit it explicitly when the user might
  // otherwise miss it (i.e. when there are flags below).
  const verb =
    m.method.toUpperCase() === "GET" ? "" : `${m.method.toUpperCase()} `;
  return `# recker: npm install -g recker (https://forattini-dev.github.io/recker)\nrek ${verb}${m.url}${flags.length ? " " + flags.join(" ") : ""}`;
}

const pyStr = (s: string) =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const pyDict = (h: { name: string; value: string }[]) =>
  `{${h.map((x) => `${pyStr(x.name)}: ${pyStr(x.value)}`).join(", ")}}`;

const EMITTERS: Record<SnippetLang, (m: HttpModel) => string> = {
  curl,
  httpie,
  fetch,
  axios,
  python,
  go,
  recker,
};

/** Generate a snippet for an (already variable-resolved) HTTP request. */
export function generateSnippet(
  req: RequestDefinition,
  lang: SnippetLang
): string {
  if (req.kind !== "http")
    return `# code generation is available for HTTP requests only`;
  try {
    return EMITTERS[lang](buildModel(req));
  } catch (e) {
    return `# could not generate ${lang}: ${e instanceof Error ? e.message : e}`;
  }
}
