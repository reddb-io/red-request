import { describe, it, expect } from "vitest";
import { parseSchema, INTROSPECTION_QUERY } from "./graphql.js";

// A trimmed-down `__schema` payload shaped like a real introspection response.
const introspection = {
  queryType: { name: "Query" },
  mutationType: { name: "Mutation" },
  subscriptionType: { name: "Subscription" },
  types: [
    {
      name: "Query",
      kind: "OBJECT",
      description: "Root query",
      fields: [
        {
          name: "user",
          description: "Fetch a user by id",
          args: [{ name: "id" }],
          type: {
            kind: "NON_NULL",
            name: null,
            ofType: { kind: "OBJECT", name: "User" },
          },
        },
      ],
    },
    {
      name: "Mutation",
      kind: "OBJECT",
      fields: [
        {
          name: "createUser",
          args: [{ name: "name" }, { name: "email" }],
          type: { kind: "OBJECT", name: "User" },
        },
      ],
    },
    {
      name: "Subscription",
      kind: "OBJECT",
      fields: [
        { name: "userAdded", args: [], type: { kind: "OBJECT", name: "User" } },
      ],
    },
    {
      name: "User",
      kind: "OBJECT",
      fields: [
        { name: "id", args: [], type: { kind: "SCALAR", name: "ID" } },
        {
          name: "tags",
          args: [],
          type: {
            kind: "LIST",
            name: null,
            ofType: {
              kind: "NON_NULL",
              name: null,
              ofType: { kind: "SCALAR", name: "String" },
            },
          },
        },
      ],
    },
    // Introspection meta-types must be dropped from the explorer.
    { name: "__Type", kind: "OBJECT", fields: [] },
  ],
};

describe("INTROSPECTION_QUERY", () => {
  it("asks for the schema root types", () => {
    expect(INTROSPECTION_QUERY).toContain("__schema");
    expect(INTROSPECTION_QUERY).toContain("queryType");
    expect(INTROSPECTION_QUERY).toContain("mutationType");
    expect(INTROSPECTION_QUERY).toContain("subscriptionType");
  });
});

describe("parseSchema", () => {
  const schema = parseSchema(introspection);

  it("captures the root operation type names", () => {
    expect(schema.queryType).toBe("Query");
    expect(schema.mutationType).toBe("Mutation");
    expect(schema.subscriptionType).toBe("Subscription");
  });

  it("drops introspection meta-types and sorts by name", () => {
    const names = schema.types.map((t) => t.name);
    expect(names).not.toContain("__Type");
    expect(names).toEqual(["Mutation", "Query", "Subscription", "User"]);
  });

  it("renders SDL-ish type refs for NON_NULL / LIST wrappers", () => {
    const user = schema.types.find((t) => t.name === "User")!;
    expect(user.fields.find((f) => f.name === "id")!.type).toBe("ID");
    expect(user.fields.find((f) => f.name === "tags")!.type).toBe("[String!]");

    const query = schema.types.find((t) => t.name === "Query")!;
    const field = query.fields.find((f) => f.name === "user")!;
    expect(field.type).toBe("User!");
    expect(field.args).toEqual(["id"]);
    expect(field.desc).toBe("Fetch a user by id");
  });

  it("is total over empty / missing input", () => {
    expect(parseSchema(undefined)).toEqual({
      queryType: undefined,
      mutationType: undefined,
      subscriptionType: undefined,
      types: [],
    });
    expect(parseSchema({}).types).toEqual([]);
  });
});
