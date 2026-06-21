// Turn a Postman v2.1 collection into our collection: walk the (nested) item tree, flattening
// folders into our single-level folder labels. Postman already uses {{var}} syntax, so URLs and
// headers carry straight over. Pass the parsed JSON.
import { newRequest, type RequestDefinition, type Kv } from "./request.js";
import type { ImportedCollection } from "./import-openapi.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
function urlOf(u: any): string {
  if (!u) return "";
  if (typeof u === "string") return u;
  if (u.raw) return u.raw;
  const host = Array.isArray(u.host) ? u.host.join(".") : (u.host ?? "");
  const path = Array.isArray(u.path) ? u.path.join("/") : (u.path ?? "");
  const proto = u.protocol ? `${u.protocol}://` : "";
  return `${proto}${host}${path ? "/" + path : ""}`;
}

function bodyOf(body: any): RequestDefinition["body"] | null {
  if (!body) return null;
  switch (body.mode) {
    case "raw": {
      const lang = body.options?.raw?.language;
      return {
        type: lang === "json" ? "json" : "raw",
        content: body.raw ?? "",
        fields: [],
      };
    }
    case "urlencoded":
      return {
        type: "form",
        content: "",
        fields: (body.urlencoded ?? []).map(
          (p: any): Kv => ({
            name: p.key,
            value: p.value ?? "",
            enabled: !p.disabled,
          })
        ),
      };
    case "formdata":
      return {
        type: "multipart",
        content: "",
        fields: (body.formdata ?? []).map(
          (p: any): Kv => ({
            name: p.key,
            value: p.value ?? "",
            enabled: !p.disabled,
          })
        ),
      };
    case "graphql":
      return {
        type: "graphql",
        content: body.graphql?.query ?? "",
        variables: body.graphql?.variables ?? "",
        fields: [],
      };
    default:
      return null;
  }
}

export function postmanToCollection(spec: unknown): ImportedCollection {
  const root = spec as any;
  if (!root?.info || !Array.isArray(root.item))
    throw new Error("not a Postman collection (missing info/item)");

  const requests: RequestDefinition[] = [];
  const folders = new Set<string>();
  let n = 0;

  const walk = (items: any[], folder: string) => {
    for (const it of items ?? []) {
      if (Array.isArray(it.item)) {
        // a folder — flatten its name as our folder label
        if (it.name) folders.add(it.name);
        walk(it.item, it.name ?? folder);
        continue;
      }
      const pr = it.request;
      if (!pr) continue;
      const req = newRequest(`pm-${(n++).toString(36)}`);
      req.method = (
        typeof pr === "string" ? "GET" : (pr.method ?? "GET")
      ).toUpperCase();
      req.url = urlOf(pr.url);
      req.name = (it.name || `${req.method} ${req.url}`).slice(0, 80);
      if (folder) req.folder = folder;
      req.headers = (pr.header ?? []).map(
        (h: any): Kv => ({
          name: h.key,
          value: h.value ?? "",
          enabled: !h.disabled,
        })
      );
      const q = pr.url?.query;
      if (Array.isArray(q))
        req.query = q.map(
          (p: any): Kv => ({
            name: p.key,
            value: p.value ?? "",
            enabled: !p.disabled,
          })
        );
      const body = bodyOf(pr.body);
      if (body) req.body = body;
      requests.push(req);
    }
  };
  walk(root.item, "");

  return {
    name: root.info.name || "Postman import",
    baseUrl: "",
    vars: {},
    folders: [...folders],
    requests,
  };
}
