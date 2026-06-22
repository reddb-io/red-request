// Turn an OpenAPI 3 / Swagger 2 document (already parsed from JSON or YAML) into a collection
// of requests — one per path × method, grouped into folders by the first tag. The server URL
// becomes a {{baseUrl}} variable; `{param}` path segments become our `:param` form.
import { newRequest, type RequestDefinition, type Kv } from "./request.js";

export interface ImportedCollection {
  name: string;
  baseUrl: string;
  vars: Record<string, string>;
  folders: string[];
  requests: RequestDefinition[];
}

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

/** A shallow, bounded sample value for a schema (uses `example` when present). */
function sample(root: Obj, schema: any, depth = 0): any {
  const s = deref(root, schema);
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (depth > 4) return null;
  const type = s.type ?? (s.properties ? "object" : undefined);
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
    default:
      return s.properties ? sample(root, { ...s, type: "object" }, depth) : "";
  }
}

function baseUrlOf(spec: Obj): string {
  // OpenAPI 3
  const server = spec.servers?.[0]?.url;
  if (typeof server === "string" && server) return server;
  // Swagger 2
  if (spec.host) {
    const scheme = spec.schemes?.[0] ?? "https";
    return `${scheme}://${spec.host}${spec.basePath ?? ""}`;
  }
  return "";
}

export function openapiToCollection(spec: unknown): ImportedCollection {
  const root = spec as Obj;
  if (!root?.paths)
    throw new Error("not an OpenAPI/Swagger document (no `paths`)");

  const baseUrl = baseUrlOf(root);
  const name = root.info?.title?.trim() || "Imported API";
  const requests: RequestDefinition[] = [];
  const folders = new Set<string>();
  let n = 0;

  for (const [path, pathItemRaw] of Object.entries<Obj>(root.paths)) {
    const pathItem = deref(root, pathItemRaw);
    const sharedParams: any[] = (pathItem.parameters ?? []).map((p: any) =>
      deref(root, p)
    );

    for (const method of METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      const id = `oa-${(n++).toString(36)}-${method}`;
      const req = newRequest(id);
      req.method = method.toUpperCase() as RequestDefinition["method"];
      // {param} → :param
      req.url = `{{baseUrl}}${path.replace(/\{([^}]+)\}/g, ":$1")}`;
      req.name = (
        op.summary ||
        op.operationId ||
        `${method.toUpperCase()} ${path}`
      ).slice(0, 80);

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
        const kv: Kv = {
          name: p.name,
          value: String(p.example ?? p.default ?? ""),
          enabled: true,
        };
        if (p.in === "query") query.push(kv);
        else if (p.in === "header") headers.push(kv);
        else if (p.in === "path") pathParams.push(kv);
      }
      req.query = query;
      req.headers = headers;
      req.pathParams = pathParams;

      // request body (OpenAPI 3 requestBody.content, or Swagger 2 in:body param)
      const json = op.requestBody?.content?.["application/json"];
      const bodyParam = params.find((p) => p.in === "body");
      const schema = json?.schema ?? bodyParam?.schema;
      if (schema || json?.example) {
        const value = json?.example ?? sample(root, schema);
        req.body = {
          type: "json",
          content: JSON.stringify(value, null, 2),
          fields: [],
        };
        if (!headers.some((h) => h.name.toLowerCase() === "content-type"))
          req.headers.push({
            name: "Content-Type",
            value: "application/json",
            enabled: true,
          });
      }

      requests.push(req);
    }
  }

  return {
    name,
    baseUrl,
    vars: baseUrl ? { baseUrl } : {},
    folders: [...folders],
    requests,
  };
}
