// Turn an OpenAPI 3.x / Swagger 2 document (already parsed from JSON or YAML) into a
// collection of requests — one per path × method, grouped into folders by the first tag.
// Servers become importable environments carrying a {{baseUrl}} variable (plus one
// variable per server `variable`); `{param}` path segments become our `:param` form;
// securitySchemes map onto AuthConfig; request bodies cover json / form / multipart /
// xml / raw; 2xx responses become saved examples.
import type { AuthConfig } from "./auth.js";
import {
  newRequest,
  type Kv,
  type RequestBody,
  type RequestDefinition,
  type SavedExample,
} from "./request.js";

/** An environment to create alongside the collection (one per OpenAPI server). */
export interface ImportedEnvironment {
  name: string;
  vars: Record<string, string>;
}

export interface ImportedCollection {
  name: string;
  baseUrl: string;
  vars: Record<string, string>;
  folders: string[];
  requests: RequestDefinition[];
  /** info.description (+ version / external docs), when present. */
  description?: string;
  /** Collection-level auth derived from the document's global `security`. */
  auth?: AuthConfig;
  /** One per `servers[]` entry — each carries its own `baseUrl` value. */
  environments?: ImportedEnvironment[];
  /** Extra per-folder metadata keyed by folder (tag) name. */
  folderMeta?: Record<string, { description?: string }>;
}

// No "trace": the engine dispatches method-named client functions and has none for it.
const METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
] as const;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

/** Resolve a local `#/a/b/c` $ref against the root document. */
function deref(root: Obj, node: any, seen = new Set<string>()): any {
  let n = node;
  while (
    n &&
    typeof n === "object" &&
    typeof n.$ref === "string" &&
    n.$ref.startsWith("#/")
  ) {
    if (seen.has(n.$ref)) return {};
    seen.add(n.$ref);
    n = n.$ref
      .slice(2)
      .split("/")
      .reduce(
        (o: any, k: string) => o?.[k.replace(/~1/g, "/").replace(/~0/g, "~")],
        root
      );
  }
  return n ?? {};
}

/** Schema `type`, tolerating the 3.1 array form (`["string","null"]`). */
function typeOf(s: Obj): string | undefined {
  if (Array.isArray(s.type)) return s.type.find((t: any) => t !== "null");
  return s.type;
}

/** A shallow, bounded sample value for a schema (uses `example`/`const` when present). */
function sample(root: Obj, schema: any, depth = 0): any {
  const s = deref(root, schema);
  if (s.example !== undefined) return s.example;
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (depth > 4) return null;
  const type = typeOf(s) ?? (s.properties ? "object" : undefined);
  switch (type) {
    case "object": {
      const out: Obj = {};
      for (const [k, v] of Object.entries(s.properties ?? {}))
        out[k] = sample(root, v, depth + 1);
      return out;
    }
    case "array":
      return [sample(root, s.items ?? {}, depth + 1)];
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "string":
      return s.format === "date-time" ? "1970-01-01T00:00:00Z" : "";
    default: {
      // allOf/oneOf/anyOf: sample the first branch
      const branch = s.allOf?.[0] ?? s.oneOf?.[0] ?? s.anyOf?.[0];
      if (branch) return sample(root, branch, depth + 1);
      return s.properties ? sample(root, { ...s, type: "object" }, depth) : "";
    }
  }
}

/** Stringify a sampled value for a Kv/form field. */
function asString(v: any): string {
  if (v === undefined || v === null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** `{var}` → `{{var}}` (server URL templating → our placeholder syntax). */
function templatize(url: string): string {
  return url.replace(/\{([^{}]+)\}/g, "{{$1}}");
}

/** Substitute server-variable defaults into a server URL. */
function substituteServerVars(url: string, variables: Obj): string {
  return url.replace(/\{([^{}]+)\}/g, (m, name) => {
    const def = variables?.[name]?.default;
    return def !== undefined ? String(def) : m;
  });
}

function hostnameOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/{}?#]+)/i.exec(url);
  return m?.[1] ?? url;
}

interface ServerInfo {
  /** URL with `{var}` converted to `{{var}}` (for env vars). */
  templated: string;
  /** URL with variable defaults substituted (for the fallback baseUrl). */
  resolved: string;
  description: string;
  variables: Obj;
}

function serversOf(spec: Obj): ServerInfo[] {
  const out: ServerInfo[] = [];
  if (Array.isArray(spec.servers)) {
    for (const server of spec.servers) {
      if (typeof server?.url !== "string" || !server.url) continue;
      const url = server.url.replace(/\/+$/, "");
      out.push({
        templated: templatize(url),
        resolved: substituteServerVars(url, server.variables ?? {}),
        description: String(server.description ?? ""),
        variables: server.variables ?? {},
      });
    }
    return out;
  }
  // Swagger 2: schemes × host + basePath
  if (spec.host) {
    const base = `${spec.host}${(spec.basePath ?? "").replace(/\/+$/, "")}`;
    const schemes: string[] =
      Array.isArray(spec.schemes) && spec.schemes.length
        ? spec.schemes
        : ["https"];
    for (const scheme of schemes) {
      const url = `${scheme}://${base}`;
      out.push({
        templated: url,
        resolved: url,
        description: "",
        variables: {},
      });
    }
  }
  return out;
}

/** Map one OpenAPI security scheme (already dereferenced) onto our AuthConfig. */
function schemeToAuth(scheme: Obj, scopes: string[]): AuthConfig | null {
  const type = String(scheme?.type ?? "").toLowerCase();
  if (type === "http") {
    const s = String(scheme.scheme ?? "").toLowerCase();
    if (s === "bearer") return { type: "bearer", token: "" };
    if (s === "basic") return { type: "basic", username: "", password: "" };
    return null;
  }
  if (type === "basic") return { type: "basic", username: "", password: "" }; // Swagger 2
  if (type === "apikey") {
    const where = String(scheme.in ?? "header").toLowerCase();
    if (where !== "header" && where !== "query") return null; // cookie: unsupported
    return {
      type: "apiKey",
      key: String(scheme.name ?? ""),
      value: "",
      in: where,
    };
  }
  if (type === "oauth2") {
    const flows: Obj = scheme.flows ?? {
      // Swagger 2 puts flow fields on the scheme itself
      [String(scheme.flow ?? "")]: scheme,
    };
    const pick = (
      grantType: "client_credentials" | "authorization_code" | "password",
      flow: Obj | undefined
    ) =>
      flow
        ? ({
            type: "oauth2",
            grantType,
            authorizeUrl: String(flow.authorizationUrl ?? ""),
            tokenUrl: String(flow.tokenUrl ?? ""),
            scope: scopes.length
              ? scopes.join(" ")
              : Object.keys(flow.scopes ?? {}).join(" "),
          } as AuthConfig)
        : null;
    return (
      pick(
        "client_credentials",
        flows.clientCredentials ?? flows.application
      ) ??
      pick("authorization_code", flows.authorizationCode ?? flows.accessCode) ??
      pick("password", flows.password) ??
      pick("authorization_code", flows.implicit)
    );
  }
  if (type === "openidconnect") {
    const url = String(scheme.openIdConnectUrl ?? "");
    return {
      type: "oauth2",
      issuer: url.replace(/\/\.well-known\/.*$/, ""),
      scope: scopes.join(" "),
    } as AuthConfig;
  }
  return null;
}

/** Resolve a `security` requirement list to an AuthConfig using the doc's schemes. */
function securityToAuth(root: Obj, security: any): AuthConfig | null {
  if (!Array.isArray(security)) return null;
  const schemes: Obj =
    root.components?.securitySchemes ?? root.securityDefinitions ?? {};
  for (const requirement of security) {
    if (!requirement || typeof requirement !== "object") continue;
    for (const [name, scopes] of Object.entries(requirement)) {
      const scheme = deref(root, schemes[name]);
      const auth = schemeToAuth(
        scheme,
        Array.isArray(scopes) ? scopes.map(String) : []
      );
      if (auth) return auth;
    }
  }
  return null;
}

/** Preference-ordered pick of a request-body media type. */
function pickMediaType(content: Obj): string | undefined {
  const keys = Object.keys(content ?? {});
  if (!keys.length) return undefined;
  const rank = (k: string): number => {
    const key = k.toLowerCase();
    if (key === "application/json" || /\+json\b/.test(key)) return 0;
    if (key === "application/x-www-form-urlencoded") return 1;
    if (key === "multipart/form-data") return 2;
    if (key === "application/xml" || key === "text/xml") return 3;
    if (key === "text/plain") return 4;
    return 5;
  };
  return [...keys].sort((a, b) => rank(a) - rank(b))[0];
}

/** Minimal XML rendering of a sampled value (crude by design). */
function xmlSample(name: string, value: any, depth = 0): string {
  const pad = "  ".repeat(depth);
  if (value === null || value === undefined) return `${pad}<${name}/>`;
  if (Array.isArray(value))
    return value.map((v) => xmlSample(name, v, depth)).join("\n");
  if (typeof value === "object") {
    const inner = Object.entries(value)
      .map(([k, v]) => xmlSample(k, v, depth + 1))
      .join("\n");
    return `${pad}<${name}>\n${inner}\n${pad}</${name}>`;
  }
  return `${pad}<${name}>${String(value)}</${name}>`;
}

/** Schema `properties` → form/multipart Kv fields (required ones enabled). */
function schemaToFields(root: Obj, schema: Obj): Kv[] {
  const s = deref(root, schema);
  const required = new Set<string>(
    Array.isArray(s.required) ? s.required.map(String) : []
  );
  return Object.entries(s.properties ?? {}).map(([name, propRaw]) => {
    const prop = deref(root, propRaw);
    const binary = prop.format === "binary" || prop.type === "file";
    return {
      name,
      value: binary ? "" : asString(sample(root, prop, 1)),
      enabled: required.size === 0 || required.has(name),
    };
  });
}

/** Build the request body (+ Content-Type) for an operation. */
function bodyFor(
  root: Obj,
  op: Obj,
  params: Obj[],
  spec: Obj
): { body: RequestBody; contentType: string } | null {
  // OpenAPI 3: requestBody.content
  const requestBody = deref(root, op.requestBody);
  const content: Obj = requestBody?.content ?? {};
  const mediaType = pickMediaType(content);
  if (mediaType) {
    const media = content[mediaType];
    const schema = media?.schema;
    const example =
      media?.example ??
      (media?.examples
        ? deref(root, Object.values<Obj>(media.examples)[0])?.value
        : undefined);
    const key = mediaType.toLowerCase();
    if (key === "application/json" || /\+json\b/.test(key)) {
      const value = example ?? (schema ? sample(root, schema) : undefined);
      if (value === undefined) return null;
      return {
        body: {
          type: "json",
          content: JSON.stringify(value, null, 2),
          fields: [],
        },
        contentType: mediaType,
      };
    }
    if (key === "application/x-www-form-urlencoded")
      return {
        body: {
          type: "form",
          content: "",
          fields: schemaToFields(root, schema ?? {}),
        },
        contentType: mediaType,
      };
    if (key === "multipart/form-data")
      return {
        body: {
          type: "multipart",
          content: "",
          fields: schemaToFields(root, schema ?? {}),
        },
        contentType: mediaType,
      };
    if (key === "application/xml" || key === "text/xml") {
      const s = deref(root, schema ?? {});
      const rootName = s.xml?.name ?? "root";
      return {
        body: {
          type: "xml",
          content:
            typeof example === "string"
              ? example
              : xmlSample(rootName, sample(root, s)),
          fields: [],
        },
        contentType: mediaType,
      };
    }
    // text/plain and everything else → raw
    const value = example ?? (schema ? sample(root, schema) : "");
    return {
      body: {
        type: "raw",
        content:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
        fields: [],
      },
      contentType: mediaType,
    };
  }

  // Swagger 2: in:body / in:formData params (consumes selects the media type)
  const consumes: string[] = op.consumes ?? spec.consumes ?? [];
  const formParams = params.filter((p) => p.in === "formData");
  if (formParams.length) {
    const multipart = consumes.includes("multipart/form-data");
    return {
      body: {
        type: multipart ? "multipart" : "form",
        content: "",
        fields: formParams.map((p) => ({
          name: String(p.name ?? ""),
          value:
            p.type === "file" ? "" : asString(p.example ?? p.default ?? ""),
          enabled: p.required === true,
        })),
      },
      contentType: multipart
        ? "multipart/form-data"
        : "application/x-www-form-urlencoded",
    };
  }
  const bodyParam = params.find((p) => p.in === "body");
  if (bodyParam?.schema) {
    return {
      body: {
        type: "json",
        content: JSON.stringify(sample(root, bodyParam.schema), null, 2),
        fields: [],
      },
      contentType: consumes.find((c) => /json/.test(c)) ?? "application/json",
    };
  }
  return null;
}

/** 2xx-first saved examples from an operation's `responses`. */
function examplesFor(root: Obj, op: Obj): SavedExample[] {
  const responses: Obj = op.responses ?? {};
  const codes = Object.keys(responses).sort((a, b) => {
    const ok = (c: string) => (/^2/.test(c) ? 0 : 1);
    return ok(a) - ok(b) || a.localeCompare(b);
  });
  const out: SavedExample[] = [];
  for (const code of codes) {
    if (out.length >= 3) break;
    const res = deref(root, responses[code]);
    // OpenAPI 3 content, or Swagger 2 res.schema / res.examples
    const content: Obj = res.content ?? {};
    const mediaType =
      Object.keys(content).find((k) => /json/.test(k)) ??
      Object.keys(content)[0];
    const media = mediaType ? content[mediaType] : undefined;
    const value =
      media?.example ??
      (media?.examples
        ? deref(root, Object.values<Obj>(media.examples)[0])?.value
        : undefined) ??
      (media?.schema ? sample(root, media.schema) : undefined) ??
      (res.schema ? sample(root, res.schema) : undefined) ??
      res.examples?.["application/json"];
    if (value === undefined) continue;
    const status = Number(code) || 0;
    out.push({
      id: `ex-${code}`,
      name: `${code}${res.description ? ` ${res.description}` : ""}`.slice(
        0,
        80
      ),
      status,
      statusText: "",
      contentType: mediaType ?? "application/json",
      bodyText:
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
      savedAt: 0,
    });
  }
  return out;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function openapiToCollection(spec: unknown): ImportedCollection {
  const root = spec as Obj;
  if (!root?.paths) {
    if (root?.webhooks)
      throw new Error(
        "this OpenAPI 3.1 document only defines webhooks — nothing to import"
      );
    throw new Error("not an OpenAPI/Swagger document (no `paths`)");
  }

  const name = root.info?.title?.trim() || "Imported API";
  const servers = serversOf(root);
  const baseUrl = servers[0]?.resolved ?? "";

  // One environment per server, each carrying its own baseUrl (+ server variables).
  const environments: ImportedEnvironment[] = servers.map((server, i) => {
    const vars: Record<string, string> = { baseUrl: server.templated };
    for (const [varName, config] of Object.entries<Obj>(server.variables))
      vars[varName] = String(config?.default ?? "");
    const label =
      server.description || hostnameOf(server.resolved) || `server ${i + 1}`;
    return { name: `${name} — ${label}`, vars };
  });

  const descriptionParts = [
    root.info?.description?.trim(),
    root.info?.version ? `Version: ${root.info.version}` : "",
    root.externalDocs?.url ? `Docs: ${root.externalDocs.url}` : "",
  ].filter(Boolean);

  // Folder metadata + ordering from the root-level `tags` list.
  const folderMeta: Record<string, { description?: string }> = {};
  const tagOrder: string[] = [];
  if (Array.isArray(root.tags))
    for (const tag of root.tags) {
      if (!tag?.name) continue;
      tagOrder.push(String(tag.name));
      if (tag.description)
        folderMeta[String(tag.name)] = { description: String(tag.description) };
    }

  const collectionAuth = securityToAuth(root, root.security) ?? undefined;

  const requests: RequestDefinition[] = [];
  const folders = new Set<string>();
  const usedIds = new Set<string>();
  let n = 0;

  for (const [path, pathItemRaw] of Object.entries<Obj>(root.paths)) {
    const pathItem = deref(root, pathItemRaw);
    const sharedParams: any[] = (pathItem.parameters ?? []).map((p: any) =>
      deref(root, p)
    );
    // Path-level server override: use its URL literally instead of {{baseUrl}}.
    const pathServer: string | undefined = pathItem.servers?.[0]?.url;

    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      let id = "";
      if (typeof op.operationId === "string" && op.operationId.trim()) {
        const slug = slugify(op.operationId);
        if (slug && !usedIds.has(`oa-${slug}`)) id = `oa-${slug}`;
      }
      if (!id) id = `oa-${n.toString(36)}-${method}`;
      usedIds.add(id);
      n++;

      const req = newRequest(id);
      req.method = method.toUpperCase() as RequestDefinition["method"];
      // {param} → :param
      const prefix = pathServer
        ? templatize(pathServer.replace(/\/+$/, ""))
        : "{{baseUrl}}";
      req.url = `${prefix}${path.replace(/\{([^}]+)\}/g, ":$1")}`;
      req.name = (
        op.summary ||
        op.operationId ||
        `${method.toUpperCase()} ${path}`
      ).slice(0, 80);
      req.description = String(op.description ?? op.summary ?? "");
      req.deprecated = op.deprecated === true;

      const tag = Array.isArray(op.tags) ? op.tags[0] : undefined;
      if (tag) {
        req.folder = String(tag);
        folders.add(String(tag));
      }

      const params: any[] = [
        ...sharedParams,
        ...(op.parameters ?? []).map((p: any) => deref(root, p)),
      ];
      const query: Kv[] = [];
      const headers: Kv[] = [];
      const pathParams: Kv[] = [];
      for (const p of params) {
        if (p.in === "body" || p.in === "formData") continue;
        const schema = p.schema ? deref(root, p.schema) : undefined;
        const value = asString(
          p.example ??
            (p.examples
              ? deref(root, Object.values<Obj>(p.examples)[0])?.value
              : undefined) ??
            schema?.example ??
            schema?.default ??
            p.default ??
            ""
        );
        const kv: Kv = { name: p.name, value, enabled: true };
        if (p.in === "query") {
          kv.enabled = p.required === true;
          query.push(kv);
        } else if (p.in === "header") {
          kv.enabled = p.required === true;
          headers.push(kv);
        } else if (p.in === "path") pathParams.push(kv);
      }
      req.query = query;
      req.headers = headers;
      req.pathParams = pathParams;

      const bodyInfo = bodyFor(root, op, params, root);
      if (bodyInfo) {
        req.body = bodyInfo.body;
        // form/multipart Content-Type is set by the engine (boundary etc.)
        const needsHeader =
          bodyInfo.body.type !== "form" && bodyInfo.body.type !== "multipart";
        if (
          needsHeader &&
          !headers.some((h) => h.name.toLowerCase() === "content-type")
        )
          req.headers.push({
            name: "Content-Type",
            value: bodyInfo.contentType,
            enabled: true,
          });
      }

      // Per-operation security: [] means "no auth"; a different scheme overrides.
      if (Array.isArray(op.security)) {
        req.auth =
          op.security.length === 0
            ? { type: "none" }
            : (securityToAuth(root, op.security) ?? { type: "inherit" });
      }

      req.examples = examplesFor(root, op);
      requests.push(req);
    }
  }

  // Order folders by the root tags list, then any stragglers alphabetically.
  const orderedFolders = [
    ...tagOrder.filter((t) => folders.has(t)),
    ...[...folders].filter((f) => !tagOrder.includes(f)).sort(),
  ];

  return {
    name,
    baseUrl,
    vars: baseUrl ? { baseUrl } : {},
    folders: orderedFolders,
    requests,
    description: descriptionParts.join("\n\n") || undefined,
    auth: collectionAuth,
    environments: environments.length ? environments : undefined,
    folderMeta: Object.keys(folderMeta).length ? folderMeta : undefined,
  };
}
