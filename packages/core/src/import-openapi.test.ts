import { describe, it, expect } from "vitest";
import { openapiToCollection } from "./import-openapi.js";

const spec = {
  openapi: "3.0.0",
  info: { title: "Petstore" },
  servers: [{ url: "https://api.petstore.io/v1" }],
  paths: {
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        tags: ["pets"],
        summary: "Get a pet",
        parameters: [
          {
            name: "petId",
            in: "path",
            required: true,
            schema: { type: "integer" },
          },
          { name: "verbose", in: "query", schema: { type: "boolean" } },
        ],
      },
    },
    "/pets": {
      post: {
        tags: ["pets"],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  age: { type: "integer" },
                },
              },
            },
          },
        },
      },
    },
  },
};

describe("openapiToCollection", () => {
  const c = openapiToCollection(spec);
  it("titles + baseUrl + folders", () => {
    expect(c.name).toBe("Petstore");
    expect(c.baseUrl).toBe("https://api.petstore.io/v1");
    expect(c.folders).toContain("pets");
    expect(c.vars.baseUrl).toBe("https://api.petstore.io/v1");
  });
  it("GET with path + query params", () => {
    const get = c.requests.find((r) => r.method === "GET")!;
    expect(get.url).toBe("{{baseUrl}}/pets/:petId");
    expect(get.pathParams.map((p) => p.name)).toContain("petId");
    expect(get.query.map((q) => q.name)).toContain("verbose");
    expect(get.folder).toBe("pets");
  });
  it("POST with JSON body sample + content-type", () => {
    const post = c.requests.find((r) => r.method === "POST")!;
    expect(post.body.type).toBe("json");
    expect(JSON.parse(post.body.content)).toEqual({ name: "", age: 0 });
    expect(post.headers.some((h) => h.name === "Content-Type")).toBe(true);
  });
});
