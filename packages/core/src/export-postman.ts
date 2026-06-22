// Export our collections to a Postman v2.1 collection (the inverse of import-postman).
// One red-request collection → a Postman collection; multiple → a project-named root
// collection with each as a top-level folder. Our single-level folders become nested
// item groups. `{{var}}` syntax already matches Postman, so URLs carry straight over.
import type { LoadedCollection } from "./collection.js";
import type { RequestDefinition, Kv } from "./request.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const POSTMAN_SCHEMA =
  "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

const kvOut = (kv: Kv) => ({
  key: kv.name,
  value: kv.value,
  ...(kv.enabled ? {} : { disabled: true }),
});

function bodyOut(body: RequestDefinition["body"]): any | undefined {
  switch (body.type) {
    case "json":
      return {
        mode: "raw",
        raw: body.content,
        options: { raw: { language: "json" } },
      };
    case "xml":
      return {
        mode: "raw",
        raw: body.content,
        options: { raw: { language: "xml" } },
      };
    case "raw":
      return { mode: "raw", raw: body.content };
    case "form":
      return { mode: "urlencoded", urlencoded: body.fields.map(kvOut) };
    case "multipart":
      return {
        mode: "formdata",
        formdata: body.fields.map((f) => ({ ...kvOut(f), type: "text" })),
      };
    case "graphql":
      return {
        mode: "graphql",
        graphql: { query: body.content, variables: body.variables ?? "" },
      };
    default:
      return undefined;
  }
}

function requestItem(req: RequestDefinition): any {
  const body = bodyOut(req.body);
  return {
    name: req.name,
    request: {
      method: req.method,
      header: req.headers.map(kvOut),
      url: {
        raw: req.url,
        ...(req.query.length ? { query: req.query.map(kvOut) } : {}),
      },
      ...(body ? { body } : {}),
    },
  };
}

/** Build the `item[]` for one collection: root requests first, then a group per folder. */
function collectionItems(col: LoadedCollection): any[] {
  const root = col.requests.filter((r) => !r.folder);
  const folderNames = [
    ...new Set(col.requests.map((r) => r.folder).filter(Boolean)),
  ];
  const folderGroups = folderNames.map((name) => ({
    name,
    item: col.requests.filter((r) => r.folder === name).map(requestItem),
  }));
  return [...root.map(requestItem), ...folderGroups];
}

const varsOut = (vars: Record<string, string>) =>
  Object.entries(vars).map(([key, value]) => ({ key, value }));

export function collectionsToPostman(
  cols: LoadedCollection[],
  projectName = "red-request export"
): unknown {
  if (cols.length === 1) {
    const c = cols[0]!;
    const vars = varsOut(c.collection.vars);
    return {
      info: { name: c.collection.name, schema: POSTMAN_SCHEMA },
      item: collectionItems(c),
      ...(vars.length ? { variable: vars } : {}),
    };
  }
  return {
    info: { name: projectName, schema: POSTMAN_SCHEMA },
    item: cols.map((c) => {
      const vars = varsOut(c.collection.vars);
      return {
        name: c.collection.name,
        item: collectionItems(c),
        ...(vars.length ? { variable: vars } : {}),
      };
    }),
  };
}
