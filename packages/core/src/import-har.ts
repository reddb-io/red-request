// Turn a HAR file (HTTP Archive — browser/proxy export) into a collection: one request per
// logged entry. Pass the parsed JSON.
import { newRequest, type RequestDefinition, type Kv } from "./request.js";
import type { ImportedCollection } from "./import-openapi.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const skip = (name: string) =>
  name.startsWith(":") || name.toLowerCase() === "cookie";

export function harToCollection(har: unknown): ImportedCollection {
  const entries: any[] = (har as any)?.log?.entries ?? [];
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error("not a HAR file (no log.entries)");

  const requests: RequestDefinition[] = entries.map((e, i) => {
    const hr = e.request ?? {};
    const req = newRequest(`har-${i.toString(36)}`);
    req.method = (hr.method ?? "GET").toUpperCase();
    req.url = hr.url ?? "";
    let path = req.url;
    try {
      path = new URL(req.url).pathname;
    } catch {
      /* keep raw */
    }
    req.name = `${req.method} ${path}`.slice(0, 80);
    req.headers = (hr.headers ?? [])
      .filter((h: any) => h?.name && !skip(h.name))
      .map(
        (h: any): Kv => ({ name: h.name, value: h.value ?? "", enabled: true })
      );
    // query lives in the URL already; mirror it into the query editor too
    req.query = (hr.queryString ?? []).map(
      (q: any): Kv => ({ name: q.name, value: q.value ?? "", enabled: true })
    );

    const post = hr.postData;
    if (post?.text) {
      const mime = post.mimeType ?? "";
      if (mime.includes("json"))
        req.body = { type: "json", content: post.text, fields: [] };
      else if (mime.includes("urlencoded"))
        req.body = {
          type: "form",
          content: "",
          fields: (post.params ?? []).map(
            (p: any): Kv => ({
              name: p.name,
              value: p.value ?? "",
              enabled: true,
            })
          ),
        };
      else req.body = { type: "raw", content: post.text, fields: [] };
    }
    return req;
  });

  return { name: "HAR import", baseUrl: "", vars: {}, folders: [], requests };
}
