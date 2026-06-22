import { describe, it, expect } from "vitest";
import { harToCollection } from "./import-har.js";
import { postmanToCollection } from "./import-postman.js";

describe("harToCollection", () => {
  const c = harToCollection({
    log: {
      entries: [
        {
          request: {
            method: "POST",
            url: "https://api.x.com/v1/items?page=2",
            headers: [
              { name: ":method", value: "POST" },
              { name: "X-Trace", value: "abc" },
            ],
            queryString: [{ name: "page", value: "2" }],
            postData: { mimeType: "application/json", text: '{"a":1}' },
          },
        },
      ],
    },
  });
  it("maps entry → request, drops pseudo-headers, json body", () => {
    expect(c.requests).toHaveLength(1);
    const r = c.requests[0]!;
    expect(r.method).toBe("POST");
    expect(r.headers.map((h) => h.name)).toEqual(["X-Trace"]);
    expect(r.query[0]!.name).toBe("page");
    expect(r.body.type).toBe("json");
  });
});

describe("postmanToCollection", () => {
  const c = postmanToCollection({
    info: { name: "My API" },
    item: [
      {
        name: "Users",
        item: [
          {
            name: "Create user",
            request: {
              method: "POST",
              url: {
                raw: "https://{{base}}/users",
                host: ["{{base}}"],
                path: ["users"],
              },
              header: [{ key: "Authorization", value: "Bearer {{tok}}" }],
              body: {
                mode: "raw",
                options: { raw: { language: "json" } },
                raw: '{"n":1}',
              },
            },
          },
        ],
      },
    ],
  });
  it("flattens folders, keeps {{vars}}, maps json body", () => {
    expect(c.name).toBe("My API");
    expect(c.folders).toContain("Users");
    const r = c.requests[0]!;
    expect(r.folder).toBe("Users");
    expect(r.url).toBe("https://{{base}}/users");
    expect(r.headers[0]!.value).toBe("Bearer {{tok}}");
    expect(r.body.type).toBe("json");
  });
});
