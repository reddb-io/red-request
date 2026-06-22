import { describe, it, expect } from "vitest";
import { collectionsToPostman } from "./export-postman.js";
import { collectionsToInsomnia } from "./export-insomnia.js";
import { postmanToCollection } from "./import-postman.js";
import { insomniaToCollection } from "./import-insomnia.js";
import { collectionFileSchema, type LoadedCollection } from "./collection.js";
import { newRequest } from "./request.js";

function sampleCollection(): LoadedCollection {
  const r1 = newRequest("a");
  r1.name = "Create user";
  r1.method = "POST";
  r1.url = "https://{{base}}/users";
  r1.folder = "Users";
  r1.headers = [
    { name: "Authorization", value: "Bearer {{tok}}", enabled: true },
  ];
  r1.query = [{ name: "page", value: "2", enabled: true }];
  r1.body = { type: "json", content: '{"n":1}', fields: [] };

  const r2 = newRequest("b");
  r2.name = "List";
  r2.method = "GET";
  r2.url = "https://{{base}}/users";

  return {
    id: "col-1",
    collection: collectionFileSchema.parse({
      name: "My API",
      vars: { base: "api.x.com", tok: "secret" },
      folders: ["Users"],
      order: ["a", "b"],
    }),
    requests: [r1, r2],
    environments: [],
  };
}

describe("Postman export → import round-trip", () => {
  const col = sampleCollection();
  const exported = collectionsToPostman([col]);
  const reimported = postmanToCollection(exported);

  it("preserves name, folders, url, headers, body, vars", () => {
    expect(reimported.name).toBe("My API");
    expect(reimported.folders).toContain("Users");
    const create = reimported.requests.find((r) => r.name === "Create user")!;
    expect(create.method).toBe("POST");
    expect(create.folder).toBe("Users");
    expect(create.url).toBe("https://{{base}}/users");
    expect(create.headers[0]!.value).toBe("Bearer {{tok}}");
    expect(create.query[0]!.name).toBe("page");
    expect(create.body.type).toBe("json");
  });
});

describe("Insomnia export → import round-trip", () => {
  const col = sampleCollection();
  const exported = collectionsToInsomnia([col]);
  const reimported = insomniaToCollection(exported);

  it("preserves requests, folders, headers, query, body and vars", () => {
    const create = reimported.requests.find((r) => r.name === "Create user")!;
    expect(create.method).toBe("POST");
    expect(create.folder).toBe("Users");
    expect(create.url).toBe("https://{{base}}/users");
    expect(create.headers[0]!.value).toBe("Bearer {{tok}}");
    expect(create.query[0]!.name).toBe("page");
    expect(create.body.type).toBe("json");
    expect(create.body.content).toBe('{"n":1}');
    expect(reimported.vars.base).toBe("api.x.com");
  });
});
