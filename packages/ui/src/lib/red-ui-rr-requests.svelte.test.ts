import { describe, expect, it } from "vitest";
import type { QueryResult } from "../../node_modules/@reddb-io/ui/src/lib/reddb/client";
// Import the pure renderer helpers from the embedded package source. The public
// renderer barrel mounts Svelte components that use red-ui's own `$lib` alias,
// which collides with red-request's test alias.
import {
  extractDocuments,
  hasDocumentShape,
} from "../../node_modules/@reddb-io/ui/src/lib/renderers/document-render";

describe("embedded red-ui rr_requests document preview", () => {
  it("keeps rr_requests on the document preview path with readable request titles", () => {
    const result: QueryResult = {
      ok: true,
      query: "SELECT * FROM rr_requests LIMIT 200",
      capability: "document",
      record_count: 1,
      result: {
        columns: ["rid", "kind", "body"],
        records: [
          {
            values: {
              rid: 42,
              kind: "document",
              body: {
                record_type: "request",
                app_key: "c1.r1",
                collection_id: "c1",
                request_id: "r1",
                title: "GET users",
                request_name: "GET users",
                request_kind: "http",
                request_method: "GET",
                request_url: "https://api.test/users",
                request_folder: "",
                request_target: "https://api.test/users",
                search_text: "c1 r1 get users http get https://api.test/users",
                request: { id: "r1", name: "GET users" },
              },
            },
          },
        ],
      },
    };

    expect(hasDocumentShape(result)).toBe(true);
    expect(extractDocuments(result)[0]).toMatchObject({
      rid: "42",
      title: "GET users",
    });
  });
});
