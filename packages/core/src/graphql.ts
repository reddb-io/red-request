// GraphQL introspection: the standard introspection query plus a pure parser that
// turns a `__schema` payload into the schema model the explorer renders. Lives in
// core (next to the other import/parse functions) so it can be unit-tested without
// the UI; see graphql.test.ts.
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      name
      kind
      description
      fields(includeDeprecated: true) {
        name
        description
        args { name }
        type { ...TypeRef }
      }
    }
  }
}
fragment TypeRef on __Type {
  kind
  name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
}`;

export interface GqlField {
  name: string;
  type: string;
  desc?: string;
  args: string[];
}
export interface GqlType {
  name: string;
  kind: string;
  desc?: string;
  fields: GqlField[];
}
export interface GqlSchema {
  queryType?: string;
  mutationType?: string;
  subscriptionType?: string;
  types: GqlType[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Render a type ref as SDL-ish text: `[User!]!`. */
function typeName(t: any): string {
  if (!t) return "";
  if (t.kind === "NON_NULL") return typeName(t.ofType) + "!";
  if (t.kind === "LIST") return "[" + typeName(t.ofType) + "]";
  return t.name ?? "";
}

/** Parse a `__schema` introspection payload into the explorer's schema model. */
export function parseSchema(s: any): GqlSchema {
  const types: GqlType[] = (s?.types ?? [])
    .filter((t: any) => t?.name && !t.name.startsWith("__"))
    .map((t: any) => ({
      name: t.name,
      kind: t.kind,
      desc: t.description ?? undefined,
      fields: (t.fields ?? []).map((f: any) => ({
        name: f.name,
        type: typeName(f.type),
        desc: f.description ?? undefined,
        args: (f.args ?? []).map((a: any) => a.name),
      })),
    }))
    .sort((a: GqlType, b: GqlType) => a.name.localeCompare(b.name));
  return {
    queryType: s?.queryType?.name,
    mutationType: s?.mutationType?.name,
    subscriptionType: s?.subscriptionType?.name,
    types,
  };
}
