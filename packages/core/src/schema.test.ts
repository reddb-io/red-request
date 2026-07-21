import { describe, it, expect } from "vitest";
import { requestDefinitionSchema, newRequest } from "./request.js";
import {
  collectionFileSchema,
  resolveScopedRequest,
  resolveScopedVariables,
  mergeCollectionDefaultHeaders,
  resolveCollectionRootOrder,
} from "./collection.js";
import { environmentFileSchema } from "./collection.js";
import { authConfigSchema } from "./auth.js";

describe("requestDefinitionSchema", () => {
  it("applies defaults for a minimal request", () => {
    const def = requestDefinitionSchema.parse({ id: "abc" });
    expect(def.method).toBe("GET");
    expect(def.auth).toEqual({ type: "inherit" });
    expect(def.body.type).toBe("none");
    expect(def.headers).toEqual([]);
  });

  it("defaults saved bodies to an empty collection with no active id", () => {
    const def = requestDefinitionSchema.parse({ id: "abc" });
    expect(def.savedBodies).toEqual([]);
    expect(def.activeSavedBodyId).toBe("");
  });

  it("parses existing stored requests without a savedBodies field", () => {
    // A request persisted before saved bodies existed must still load.
    const legacy = { id: "old", name: "Legacy", url: "https://api.test" };
    const def = requestDefinitionSchema.parse(legacy);
    expect(def.savedBodies).toEqual([]);
    expect(def.activeSavedBodyId).toBe("");
  });

  it("captures the full body object for each saved body", () => {
    const def = requestDefinitionSchema.parse({
      id: "abc",
      savedBodies: [
        {
          id: "sb-1",
          name: "payment.created",
          body: { type: "json", content: '{"event":"payment.created"}' },
          savedAt: 42,
        },
      ],
      activeSavedBodyId: "sb-1",
    });
    expect(def.savedBodies[0]).toEqual({
      id: "sb-1",
      name: "payment.created",
      body: {
        type: "json",
        content: '{"event":"payment.created"}',
        fields: [],
      },
      savedAt: 42,
    });
    expect(def.activeSavedBodyId).toBe("sb-1");
  });

  it("round-trips through JSON without loss", () => {
    const def = {
      ...newRequest("r1"),
      method: "POST" as const,
      url: "https://api.test",
      auth: {
        type: "apiKey" as const,
        key: "X-Key",
        value: "v",
        in: "header" as const,
      },
    };
    const back = requestDefinitionSchema.parse(JSON.parse(JSON.stringify(def)));
    expect(back).toEqual(def);
  });
});

describe("authConfigSchema", () => {
  it("discriminates on type and fills defaults", () => {
    expect(authConfigSchema.parse({ type: "basic" })).toEqual({
      type: "basic",
      username: "",
      password: "",
    });
  });

  it("rejects unknown auth types", () => {
    expect(() => authConfigSchema.parse({ type: "magic" })).toThrow();
  });
});

describe("environmentFileSchema", () => {
  it("keeps secretRefs but never stores values", () => {
    const env = environmentFileSchema.parse({
      name: "dev",
      vars: { host: "dev.api" },
      secretRefs: ["API_KEY"],
    });
    expect(env.secretRefs).toEqual(["API_KEY"]);
    expect(Object.keys(env.vars)).toEqual(["host"]);
  });
});

describe("collectionFileSchema", () => {
  it("defaults auth to none and order to empty", () => {
    const c = collectionFileSchema.parse({ name: "My API" });
    expect(c.auth).toEqual({ type: "none" });
    expect(c.order).toEqual([]);
    expect(c.rootOrder).toEqual([]);
    expect(c.defaultHeaders).toEqual([]);
  });

  it("parses existing collection files without default headers", () => {
    const legacy = {
      name: "Legacy API",
      vars: { baseUrl: "https://api.example.test" },
    };

    const c = collectionFileSchema.parse(legacy);

    expect(c.defaultHeaders).toEqual([]);
  });

  it("accepts legacy string folders and object folders with scope config", () => {
    const c = collectionFileSchema.parse({
      name: "Scoped API",
      folders: [
        "Legacy",
        {
          name: "Admin",
          auth: { type: "bearer", token: "folder-token" },
          headers: [{ name: "X-Team", value: "folder", enabled: true }],
          vars: { tenant: "folder" },
        },
      ],
    });

    expect(c.folders).toEqual([
      { name: "Legacy", auth: { type: "inherit" }, headers: [], vars: {} },
      {
        name: "Admin",
        auth: { type: "bearer", token: "folder-token" },
        headers: [{ name: "X-Team", value: "folder", enabled: true }],
        vars: { tenant: "folder" },
      },
    ]);
  });

  it("derives the legacy root layout before persisting a mixed order", () => {
    const collection = collectionFileSchema.parse({
      name: "My API",
      order: ["root-b", "nested", "root-a"],
      folders: ["Users", "Admin"],
    });
    const rootA = { ...newRequest("root-a"), folder: "" };
    const rootB = { ...newRequest("root-b"), folder: "" };
    const nested = { ...newRequest("nested"), folder: "Users" };

    expect(
      resolveCollectionRootOrder(collection, [rootA, rootB, nested])
    ).toEqual([
      { kind: "request", id: "root-b" },
      { kind: "request", id: "root-a" },
      { kind: "folder", name: "Users" },
      { kind: "folder", name: "Admin" },
    ]);
  });

  it("keeps a persisted mixed root order and repairs stale entries", () => {
    const collection = collectionFileSchema.parse({
      name: "My API",
      order: ["root-a", "root-b"],
      folders: ["Users", "Admin"],
      rootOrder: [
        { kind: "folder", name: "Users" },
        { kind: "request", id: "root-a" },
        { kind: "folder", name: "missing" },
        { kind: "folder", name: "Users" },
      ],
    });

    expect(
      resolveCollectionRootOrder(collection, [
        newRequest("root-a"),
        newRequest("root-b"),
      ])
    ).toEqual([
      { kind: "folder", name: "Users" },
      { kind: "request", id: "root-a" },
      { kind: "request", id: "root-b" },
      { kind: "folder", name: "Admin" },
    ]);
  });
});

describe("mergeCollectionDefaultHeaders", () => {
  it("adds collection default headers that are absent from the request", () => {
    expect(
      mergeCollectionDefaultHeaders(
        [{ name: "X-Team", value: "red", enabled: true }],
        [{ name: "Accept", value: "application/json", enabled: true }]
      )
    ).toEqual([
      { name: "X-Team", value: "red", enabled: true },
      { name: "Accept", value: "application/json", enabled: true },
    ]);
  });

  it("lets request headers override collection defaults by case-insensitive name", () => {
    expect(
      mergeCollectionDefaultHeaders(
        [
          { name: "Authorization", value: "Bearer collection", enabled: true },
          { name: "X-Team", value: "red", enabled: true },
        ],
        [
          { name: "authorization", value: "Bearer request", enabled: true },
          { name: "Accept", value: "application/json", enabled: true },
        ]
      )
    ).toEqual([
      { name: "X-Team", value: "red", enabled: true },
      { name: "authorization", value: "Bearer request", enabled: true },
      { name: "Accept", value: "application/json", enabled: true },
    ]);
  });

  it("treats a disabled request header as the nearer override", () => {
    expect(
      mergeCollectionDefaultHeaders(
        [{ name: "X-Team", value: "red", enabled: true }],
        [{ name: "x-team", value: "", enabled: false }]
      )
    ).toEqual([{ name: "x-team", value: "", enabled: false }]);
  });
});

describe("resolveScopedRequest", () => {
  it("walks request folder collection auth and preserves request header overrides", () => {
    const collection = collectionFileSchema.parse({
      name: "Scoped API",
      auth: { type: "bearer", token: "collection-token" },
      defaultHeaders: [
        { name: "Authorization", value: "Bearer default", enabled: true },
        { name: "X-Team", value: "collection", enabled: true },
      ],
      folders: [
        {
          name: "Admin",
          auth: { type: "inherit" },
          headers: [
            { name: "Authorization", value: "Bearer folder", enabled: true },
            { name: "X-Team", value: "folder", enabled: true },
          ],
        },
      ],
    });
    const req = {
      ...newRequest("r1"),
      folder: "Admin",
      auth: { type: "inherit" as const },
      headers: [
        { name: "authorization", value: "Bearer request", enabled: true },
        { name: "X-Req", value: "1", enabled: true },
      ],
    };

    expect(resolveScopedRequest(collection, req)).toMatchObject({
      auth: { type: "none" },
      headers: [
        { name: "X-Team", value: "folder", enabled: true },
        { name: "authorization", value: "Bearer request", enabled: true },
        { name: "X-Req", value: "1", enabled: true },
      ],
    });
  });

  it("lets auth-generated headers override same-named defaults from any scope", () => {
    const collection = collectionFileSchema.parse({
      name: "Scoped API",
      auth: { type: "bearer", token: "collection-token" },
      defaultHeaders: [
        { name: "Authorization", value: "Bearer default", enabled: true },
        { name: "X-Team", value: "collection", enabled: true },
      ],
      folders: [
        {
          name: "Admin",
          auth: { type: "bearer", token: "folder-token" },
          headers: [
            { name: "Authorization", value: "Bearer folder", enabled: true },
            { name: "X-Team", value: "folder", enabled: true },
          ],
        },
      ],
    });
    const req = {
      ...newRequest("r1"),
      folder: "Admin",
      auth: { type: "inherit" as const },
    };

    expect(resolveScopedRequest(collection, req)).toMatchObject({
      auth: { type: "bearer", token: "folder-token" },
      headers: [{ name: "X-Team", value: "folder", enabled: true }],
    });
  });
});

describe("resolveScopedVariables", () => {
  it("honors request folder collection environment secret precedence", () => {
    const collection = collectionFileSchema.parse({
      name: "Scoped API",
      vars: { host: "collection", tenant: "collection" },
      folders: [{ name: "Admin", vars: { tenant: "folder", page: "folder" } }],
    });
    const req = {
      ...newRequest("r1"),
      folder: "Admin",
      vars: { page: "request" },
    };

    expect(
      resolveScopedVariables(collection, req, {
        environment: { host: "environment", secret: "environment" },
        secrets: { host: "secret", tenant: "secret", secret: "secret" },
      })
    ).toEqual({
      host: "collection",
      tenant: "folder",
      page: "request",
      secret: "environment",
    });
  });
});
