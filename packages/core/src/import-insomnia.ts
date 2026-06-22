// Turn an Insomnia v4 export into our collection. Insomnia is a flat `resources[]`
// list linked by parentId; we walk it, flattening request_group names into our
// single-level folder labels (like the Postman importer). Pass the parsed JSON.
import { newRequest, type RequestDefinition, type Kv } from "./request.js";
import type { ImportedCollection } from "./import-openapi.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
function bodyOf(body: any): RequestDefinition["body"] | null {
  if (!body) return null;
  const mt: string = body.mimeType ?? "";
  const params = (): Kv[] =>
    (body.params ?? []).map(
      (p: any): Kv => ({
        name: p.name,
        value: p.value ?? "",
        enabled: !p.disabled,
      })
    );
  if (mt.includes("graphql")) {
    let query = "";
    let variables = "";
    try {
      const o = JSON.parse(body.text ?? "{}");
      query = o.query ?? "";
      variables = o.variables ? JSON.stringify(o.variables, null, 2) : "";
    } catch {
      query = body.text ?? "";
    }
    return { type: "graphql", content: query, variables, fields: [] };
  }
  if (mt.includes("json"))
    return { type: "json", content: body.text ?? "", fields: [] };
  if (mt.includes("xml"))
    return { type: "xml", content: body.text ?? "", fields: [] };
  if (mt.includes("x-www-form-urlencoded"))
    return { type: "form", content: "", fields: params() };
  if (mt.includes("multipart"))
    return { type: "multipart", content: "", fields: params() };
  if (typeof body.text === "string" && body.text)
    return { type: "raw", content: body.text, fields: [] };
  return null;
}

export function insomniaToCollection(spec: unknown): ImportedCollection {
  const root = spec as any;
  const resources = root?.resources;
  if (!Array.isArray(resources))
    throw new Error("not an Insomnia export (missing resources)");

  // request_group id → name (used to label folders)
  const groups = new Map<string, string>();
  for (const r of resources)
    if (r._type === "request_group") groups.set(r._id, r.name ?? "");

  const workspace = resources.find((r: any) => r._type === "workspace");
  const name = workspace?.name || "Insomnia import";

  // Collection vars: merge every environment's flat string data.
  const vars: Record<string, string> = {};
  for (const r of resources) {
    if (r._type === "environment" && r.data && typeof r.data === "object") {
      for (const [k, v] of Object.entries(r.data))
        if (typeof v === "string") vars[k] = v;
    }
  }

  const requests: RequestDefinition[] = [];
  const folders = new Set<string>();
  let n = 0;
  for (const r of resources) {
    if (r._type !== "request") continue;
    const req = newRequest(`ins-${(n++).toString(36)}`);
    req.method = (r.method ?? "GET").toUpperCase();
    req.url = r.url ?? "";
    req.name = (r.name || `${req.method} ${req.url}`).slice(0, 80);
    const folder = groups.get(r.parentId) ?? "";
    if (folder) {
      req.folder = folder;
      folders.add(folder);
    }
    req.headers = (r.headers ?? []).map(
      (h: any): Kv => ({
        name: h.name,
        value: h.value ?? "",
        enabled: !h.disabled,
      })
    );
    req.query = (r.parameters ?? []).map(
      (p: any): Kv => ({
        name: p.name,
        value: p.value ?? "",
        enabled: !p.disabled,
      })
    );
    const body = bodyOf(r.body);
    if (body) req.body = body;
    requests.push(req);
  }

  return { name, baseUrl: "", vars, folders: [...folders], requests };
}
