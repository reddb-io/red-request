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

export interface GqlSuggestion {
  /** Identifier to insert / display. */
  label: string;
  kind: "field" | "argument";
  /** SDL-ish type of the field (omitted for arguments). */
  type?: string;
  desc?: string;
}

/** Strip NON_NULL / LIST wrappers from an SDL-ish type ref: `[User!]!` → `User`. */
function unwrap(type: string): string {
  return type.replace(/[[\]!]/g, "");
}

/**
 * Suggest GraphQL fields / arguments at `caret` within `text`, driven entirely by the
 * introspected `schema` model. Pure and total: returns `[]` when there is no schema (so the
 * editor degrades gracefully before introspection) or when the cursor is outside any
 * selection set. Resolves context by walking the brace/paren structure up to the cursor —
 * the type of the enclosing selection set determines which fields are offered, and an open
 * `(` after a field offers that field's argument names.
 */
export function suggestGraphQL(
  schema: GqlSchema | null | undefined,
  text: string,
  caret: number
): GqlSuggestion[] {
  if (!schema?.types?.length) return [];
  const byName = new Map(schema.types.map((t) => [t.name, t]));

  const before = text.slice(0, Math.max(0, caret));
  // The partial identifier being typed at the cursor (empty right after a delimiter).
  const word = (/([A-Za-z_]\w*)$/.exec(before)?.[1] ?? "").toLowerCase();

  const tokens = before.match(/[A-Za-z_]\w*|[{}()]/g) ?? [];

  // Root operation type: the keyword before the first selection set (default: query).
  let root = schema.queryType;
  for (const tok of tokens) {
    if (tok === "{") break;
    if (tok === "mutation") root = schema.mutationType;
    else if (tok === "subscription") root = schema.subscriptionType;
    else if (tok === "query") root = schema.queryType;
  }

  const typeStack: (string | undefined)[] = [];
  let pendingType: string | undefined; // base type of the last field seen at this level
  let pendingField: GqlField | undefined; // the last field object (for its args)
  let argDepth = 0; // brace/paren depth inside an argument list
  let argField: GqlField | undefined;

  const curType = () =>
    typeStack.length
      ? byName.get(typeStack[typeStack.length - 1] ?? "")
      : undefined;

  for (const tok of tokens) {
    if (argDepth > 0) {
      // Inside (...): track nested parens/braces so input objects don't open a selection set.
      if (tok === "(" || tok === "{") argDepth++;
      else if (tok === ")" || tok === "}") {
        argDepth--;
        if (argDepth === 0) argField = undefined;
      }
      continue;
    }
    if (tok === "{") {
      typeStack.push(typeStack.length === 0 ? root : pendingType);
      pendingType = undefined;
      pendingField = undefined;
    } else if (tok === "}") {
      typeStack.pop();
      pendingType = undefined;
      pendingField = undefined;
    } else if (tok === "(") {
      argDepth = 1;
      argField = pendingField;
    } else {
      const f = curType()?.fields.find((ff) => ff.name === tok);
      if (f) {
        pendingType = unwrap(f.type);
        pendingField = f;
      }
    }
  }

  const matches = (name: string) => name.toLowerCase().startsWith(word);

  if (argDepth > 0) {
    if (!argField) return [];
    return argField.args
      .filter(matches)
      .map((a) => ({ label: a, kind: "argument" as const }));
  }

  const ct = curType();
  if (!ct) return [];
  return ct.fields
    .filter((f) => matches(f.name))
    .map((f) => ({
      label: f.name,
      kind: "field" as const,
      type: f.type,
      desc: f.desc,
    }));
}
