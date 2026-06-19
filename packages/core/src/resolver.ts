import type { RequestDefinition, Kv } from "./request.js";
import type { AuthConfig } from "./auth.js";

/** A flat name→value map. */
export type VariableScope = Record<string, string>;

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;
const MAX_PASSES = 5;

/**
 * Merge cascading scopes into one lookup. Earlier scopes win, so callers pass them in
 * precedence order: request → folder → collection → environment → secret.
 */
export function mergeScopes(scopes: VariableScope[]): VariableScope {
  const out: VariableScope = {};
  // Apply in reverse so the first scope ends up overriding the rest.
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    if (!scope) continue;
    for (const [k, v] of Object.entries(scope)) out[k] = v;
  }
  return out;
}

export interface ResolveResult {
  value: string;
  unresolved: string[];
}

/**
 * Replace `{{var}}` placeholders. Values may themselves contain placeholders, so we
 * iterate up to MAX_PASSES; remaining unknown placeholders are left verbatim and
 * collected in `unresolved`.
 */
export function resolveTemplate(
  template: string,
  lookup: VariableScope
): ResolveResult {
  const unresolved = new Set<string>();
  let value = template;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    value = value.replace(PLACEHOLDER, (match, name: string) => {
      if (Object.prototype.hasOwnProperty.call(lookup, name)) {
        changed = true;
        return lookup[name] ?? "";
      }
      return match;
    });
    if (!changed) break;
  }
  // Whatever placeholders remain are genuinely unknown.
  for (const m of value.matchAll(PLACEHOLDER)) {
    if (m[1]) unresolved.add(m[1]);
  }
  return { value, unresolved: [...unresolved] };
}

function resolveKvList(
  list: Kv[],
  lookup: VariableScope,
  unresolved: Set<string>
): Kv[] {
  return list
    .filter((kv) => kv.enabled && kv.name.trim() !== "")
    .map((kv) => {
      const n = resolveTemplate(kv.name, lookup);
      const v = resolveTemplate(kv.value, lookup);
      n.unresolved.forEach((u) => unresolved.add(u));
      v.unresolved.forEach((u) => unresolved.add(u));
      return { name: n.value, value: v.value, enabled: true };
    });
}

function resolveAuth(
  auth: AuthConfig,
  lookup: VariableScope,
  unresolved: Set<string>
): AuthConfig {
  const t = (s: string) => {
    const r = resolveTemplate(s, lookup);
    r.unresolved.forEach((u) => unresolved.add(u));
    return r.value;
  };
  switch (auth.type) {
    case "basic":
    case "digest":
      return {
        ...auth,
        username: t(auth.username),
        password: t(auth.password),
      };
    case "bearer":
      return { ...auth, token: t(auth.token) };
    case "apiKey":
      return { ...auth, key: t(auth.key), value: t(auth.value) };
    case "oauth2":
      return {
        ...auth,
        tokenUrl: t(auth.tokenUrl),
        clientId: t(auth.clientId),
        clientSecret: t(auth.clientSecret),
        scope: auth.scope ? t(auth.scope) : auth.scope,
        username: auth.username ? t(auth.username) : auth.username,
        password: auth.password ? t(auth.password) : auth.password,
      };
    case "awsSigV4":
      return {
        ...auth,
        accessKeyId: t(auth.accessKeyId),
        secretAccessKey: t(auth.secretAccessKey),
        region: t(auth.region),
        service: t(auth.service),
        sessionToken: auth.sessionToken
          ? t(auth.sessionToken)
          : auth.sessionToken,
      };
    default:
      return auth;
  }
}

export interface ResolvedRequest {
  request: RequestDefinition;
  unresolved: string[];
}

/**
 * Resolve every templated field of a request against the merged lookup. Disabled
 * headers/query entries are dropped. Returns the resolved request plus the set of
 * placeholders that could not be resolved (so the UI can warn before sending).
 */
export function resolveRequest(
  def: RequestDefinition,
  lookup: VariableScope
): ResolvedRequest {
  const unresolved = new Set<string>();
  const url = resolveTemplate(def.url, lookup);
  url.unresolved.forEach((u) => unresolved.add(u));

  const body = { ...def.body };
  const content = resolveTemplate(def.body.content, lookup);
  content.unresolved.forEach((u) => unresolved.add(u));
  body.content = content.value;
  if (def.body.variables !== undefined) {
    const vars = resolveTemplate(def.body.variables, lookup);
    vars.unresolved.forEach((u) => unresolved.add(u));
    body.variables = vars.value;
  }
  body.fields = resolveKvList(def.body.fields, lookup, unresolved);

  return {
    request: {
      ...def,
      url: url.value,
      headers: resolveKvList(def.headers, lookup, unresolved),
      query: resolveKvList(def.query, lookup, unresolved),
      body,
      auth: resolveAuth(def.auth, lookup, unresolved),
    },
    unresolved: [...unresolved],
  };
}
