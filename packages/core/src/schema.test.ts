import { describe, it, expect } from "vitest";
import { requestDefinitionSchema, newRequest } from "./request.js";
import { collectionFileSchema } from "./collection.js";
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
  });
});
