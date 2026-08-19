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
  it("stable id from operationId", () => {
    const get = c.requests.find((r) => r.method === "GET")!;
    expect(get.id).toBe("oa-getpet");
  });
});

const richSpec = {
  openapi: "3.0.3",
  info: {
    title: "Acme",
    version: "2.1.0",
    description: "The Acme platform API.",
  },
  externalDocs: { url: "https://docs.acme.dev" },
  servers: [
    {
      url: "https://{region}.acme.dev/v2/",
      description: "Production",
      variables: { region: { default: "us", enum: ["us", "eu"] } },
    },
    { url: "https://staging.acme.dev/v2" },
  ],
  tags: [
    { name: "widgets", description: "Widget management" },
    { name: "admin" },
  ],
  security: [{ bearer: [] }],
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer" },
      keyQuery: { type: "apiKey", in: "query", name: "api_key" },
      oauth: {
        type: "oauth2",
        flows: {
          clientCredentials: {
            tokenUrl: "https://auth.acme.dev/token",
            scopes: { "read:widgets": "Read widgets" },
          },
        },
      },
    },
  },
  paths: {
    "/widgets": {
      get: {
        operationId: "listWidgets",
        tags: ["widgets"],
        summary: "List widgets",
        description: "Returns every widget.",
        parameters: [
          {
            name: "limit",
            in: "query",
            required: true,
            schema: { type: "integer", default: 20 },
          },
          { name: "cursor", in: "query", schema: { type: "string" } },
          {
            name: "X-Trace",
            in: "header",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                example: { widgets: [{ id: 1 }] },
              },
            },
          },
          "404": {
            description: "Not found",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { error: { type: "string" } },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "createWidget",
        tags: ["widgets"],
        security: [{ keyQuery: [] }],
        requestBody: {
          content: {
            "application/x-www-form-urlencoded": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  color: { type: "string", default: "red" },
                },
              },
            },
          },
        },
      },
    },
    "/uploads": {
      post: {
        operationId: "upload",
        tags: ["admin"],
        security: [],
        requestBody: {
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file"],
                properties: {
                  file: { type: "string", format: "binary" },
                  note: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    "/legacy": {
      put: {
        operationId: "legacyPut",
        deprecated: true,
        requestBody: {
          content: {
            "application/xml": {
              schema: {
                type: "object",
                xml: { name: "widget" },
                properties: { name: { type: "string", example: "w1" } },
              },
            },
          },
        },
      },
      patch: {
        operationId: "mergeThing",
        requestBody: {
          content: {
            "application/merge-patch+json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
};

describe("openapiToCollection — rich 3.0 documents", () => {
  const c = openapiToCollection(richSpec);
  it("servers become environments with baseUrl + server variables", () => {
    expect(c.environments).toHaveLength(2);
    expect(c.environments![0]!).toEqual({
      name: "Acme — Production",
      vars: { baseUrl: "https://{{region}}.acme.dev/v2", region: "us" },
    });
    expect(c.environments![1]!.name).toBe("Acme — staging.acme.dev");
    expect(c.environments![1]!.vars.baseUrl).toBe(
      "https://staging.acme.dev/v2"
    );
  });
  it("fallback baseUrl substitutes server-variable defaults", () => {
    expect(c.baseUrl).toBe("https://us.acme.dev/v2");
  });
  it("collection description folds in version and docs", () => {
    expect(c.description).toContain("The Acme platform API.");
    expect(c.description).toContain("Version: 2.1.0");
    expect(c.description).toContain("https://docs.acme.dev");
  });
  it("tags become ordered folders with metadata", () => {
    expect(c.folders).toEqual(["widgets", "admin"]);
    expect(c.folderMeta?.widgets?.description).toBe("Widget management");
  });
  it("global security maps to collection bearer auth", () => {
    expect(c.auth).toEqual({ type: "bearer", token: "" });
  });
  it("per-op security overrides; empty security means none", () => {
    const post = c.requests.find((r) => r.id === "oa-createwidget")!;
    expect(post.auth).toEqual({
      type: "apiKey",
      key: "api_key",
      value: "",
      in: "query",
    });
    const upload = c.requests.find((r) => r.id === "oa-upload")!;
    expect(upload.auth).toEqual({ type: "none" });
    const get = c.requests.find((r) => r.id === "oa-listwidgets")!;
    expect(get.auth).toEqual({ type: "inherit" });
  });
  it("required query params are enabled, optional ones disabled", () => {
    const get = c.requests.find((r) => r.id === "oa-listwidgets")!;
    const limit = get.query.find((q) => q.name === "limit")!;
    const cursor = get.query.find((q) => q.name === "cursor")!;
    expect(limit.enabled).toBe(true);
    expect(limit.value).toBe("20");
    expect(cursor.enabled).toBe(false);
    const trace = get.headers.find((h) => h.name === "X-Trace")!;
    expect(trace.enabled).toBe(false);
  });
  it("form-urlencoded body with required-enabled fields", () => {
    const post = c.requests.find((r) => r.id === "oa-createwidget")!;
    expect(post.body.type).toBe("form");
    expect(post.body.fields).toEqual([
      { name: "name", value: "", enabled: true },
      { name: "color", value: "red", enabled: false },
    ]);
    expect(post.headers.some((h) => h.name === "Content-Type")).toBe(false);
  });
  it("multipart body with empty binary fields", () => {
    const upload = c.requests.find((r) => r.id === "oa-upload")!;
    expect(upload.body.type).toBe("multipart");
    const file = upload.body.fields.find((f) => f.name === "file")!;
    expect(file.value).toBe("");
    expect(file.enabled).toBe(true);
  });
  it("xml body sampled from the schema", () => {
    const put = c.requests.find((r) => r.id === "oa-legacyput")!;
    expect(put.body.type).toBe("xml");
    expect(put.body.content).toContain("<widget>");
    expect(put.body.content).toContain("<name>w1</name>");
    expect(put.headers.find((h) => h.name === "Content-Type")?.value).toBe(
      "application/xml"
    );
  });
  it("+json media types map to a json body", () => {
    const patch = c.requests.find((r) => r.id === "oa-mergething")!;
    expect(patch.body.type).toBe("json");
    expect(patch.headers.find((h) => h.name === "Content-Type")?.value).toBe(
      "application/merge-patch+json"
    );
  });
  it("deprecated flag and description carry over", () => {
    const put = c.requests.find((r) => r.id === "oa-legacyput")!;
    expect(put.deprecated).toBe(true);
    const get = c.requests.find((r) => r.id === "oa-listwidgets")!;
    expect(get.description).toBe("Returns every widget.");
  });
  it("responses become 2xx-first saved examples", () => {
    const get = c.requests.find((r) => r.id === "oa-listwidgets")!;
    expect(get.examples.length).toBe(2);
    expect(get.examples[0]!.status).toBe(200);
    expect(JSON.parse(get.examples[0]!.bodyText)).toEqual({
      widgets: [{ id: 1 }],
    });
    expect(get.examples[1]!.status).toBe(404);
  });
});

describe("openapiToCollection — Swagger 2", () => {
  const c = openapiToCollection({
    swagger: "2.0",
    info: { title: "Legacy" },
    host: "api.legacy.io",
    basePath: "/v1",
    schemes: ["https", "http"],
    securityDefinitions: { basic: { type: "basic" } },
    security: [{ basic: [] }],
    paths: {
      "/things": {
        post: {
          consumes: ["application/x-www-form-urlencoded"],
          parameters: [
            { name: "name", in: "formData", required: true, type: "string" },
            { name: "tag", in: "formData", type: "string" },
          ],
        },
      },
    },
  });
  it("schemes × host/basePath become environments", () => {
    expect(c.environments?.map((e) => e.vars.baseUrl)).toEqual([
      "https://api.legacy.io/v1",
      "http://api.legacy.io/v1",
    ]);
    expect(c.baseUrl).toBe("https://api.legacy.io/v1");
  });
  it("securityDefinitions basic maps to collection auth", () => {
    expect(c.auth).toEqual({ type: "basic", username: "", password: "" });
  });
  it("formData params become a form body", () => {
    const post = c.requests[0]!;
    expect(post.body.type).toBe("form");
    expect(post.body.fields.map((f) => [f.name, f.enabled])).toEqual([
      ["name", true],
      ["tag", false],
    ]);
  });
});

describe("openapiToCollection — 3.1 tolerance", () => {
  it("nullable type arrays, const, and schema examples", () => {
    const c = openapiToCollection({
      openapi: "3.1.0",
      info: { title: "Modern" },
      paths: {
        "/x": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: ["string", "null"] },
                      kind: { const: "widget" },
                      count: { type: "integer", examples: [7] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(JSON.parse(c.requests[0]!.body.content)).toEqual({
      name: "",
      kind: "widget",
      count: 7,
    });
  });
  it("webhooks-only documents throw a friendly error", () => {
    expect(() =>
      openapiToCollection({
        openapi: "3.1.0",
        info: { title: "Hooks" },
        webhooks: { newPet: {} },
      })
    ).toThrow(/webhooks/);
  });
});
