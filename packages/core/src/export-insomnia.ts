// Export our collections to an Insomnia v4 export (the inverse of import-insomnia).
// Insomnia is a flat `resources[]` list linked by parentId: a workspace at the root,
// a request_group per collection, nested request_groups per folder, and a request per
// request. Collection vars become a base environment. Deterministic ids (no randomness)
// keep exports stable/diffable.
import type { LoadedCollection } from "./collection.js";
import type { RequestDefinition } from "./request.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
function bodyOut(body: RequestDefinition["body"]): any {
  const params = (fields: RequestDefinition["body"]["fields"]) =>
    fields.map((f) => ({
      name: f.name,
      value: f.value,
      ...(f.enabled ? {} : { disabled: true }),
    }));
  switch (body.type) {
    case "json":
      return { mimeType: "application/json", text: body.content };
    case "xml":
      return { mimeType: "application/xml", text: body.content };
    case "raw":
      return { mimeType: "text/plain", text: body.content };
    case "form":
      return {
        mimeType: "application/x-www-form-urlencoded",
        params: params(body.fields),
      };
    case "multipart":
      return { mimeType: "multipart/form-data", params: params(body.fields) };
    case "graphql": {
      let variables: unknown = undefined;
      if (body.variables) {
        try {
          variables = JSON.parse(body.variables);
        } catch {
          /* leave undefined on malformed JSON */
        }
      }
      return {
        mimeType: "application/graphql",
        text: JSON.stringify({
          query: body.content,
          variables: variables ?? {},
        }),
      };
    }
    default:
      return {};
  }
}

export function collectionsToInsomnia(
  cols: LoadedCollection[],
  projectName = "red-request"
): unknown {
  let counter = 0;
  const nextId = (p: string) => `${p}_${(counter++).toString(36)}`;
  const resources: any[] = [];
  let sort = 0;

  const wrkId = nextId("wrk");
  resources.push({
    _id: wrkId,
    _type: "workspace",
    parentId: null,
    name: projectName,
    description: "",
    scope: "collection",
  });

  for (const col of cols) {
    const colGroupId = nextId("fld");
    resources.push({
      _id: colGroupId,
      _type: "request_group",
      parentId: wrkId,
      name: col.collection.name,
      metaSortKey: sort++,
    });

    const folderIds: Record<string, string> = {};
    for (const name of new Set(
      col.requests.map((r) => r.folder).filter(Boolean)
    )) {
      const fid = nextId("fld");
      folderIds[name] = fid;
      resources.push({
        _id: fid,
        _type: "request_group",
        parentId: colGroupId,
        name,
        metaSortKey: sort++,
      });
    }

    for (const r of col.requests) {
      resources.push({
        _id: nextId("req"),
        _type: "request",
        parentId: r.folder ? folderIds[r.folder] : colGroupId,
        name: r.name,
        method: r.method,
        url: r.url,
        headers: r.headers.map((h) => ({
          name: h.name,
          value: h.value,
          ...(h.enabled ? {} : { disabled: true }),
        })),
        parameters: r.query.map((q) => ({
          name: q.name,
          value: q.value,
          ...(q.enabled ? {} : { disabled: true }),
        })),
        body: bodyOut(r.body),
        metaSortKey: sort++,
      });
    }

    if (Object.keys(col.collection.vars).length) {
      resources.push({
        _id: nextId("env"),
        _type: "environment",
        parentId: wrkId,
        name: `${col.collection.name} vars`,
        data: col.collection.vars,
      });
    }
  }

  return {
    _type: "export",
    __export_format: 4,
    __export_source: "red-request",
    resources,
  };
}
