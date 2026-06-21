import type { RequestDefinition, Kv } from "./request.js";
import type { AuthConfig } from "./auth.js";

/** A flat name→value map. */
export type VariableScope = Record<string, string>;

const PLACEHOLDER = /\{\{\s*([\w.$-]+)\s*\}\}/g;
const MAX_PASSES = 5;

// ---------------------------------------------------------------------------
// Dynamic variables — Postman-style `{{$name}}` tokens generated fresh on each
// resolve (not stored in any scope). Each occurrence is independent.
// ---------------------------------------------------------------------------
const randInt = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;
const pick = <T>(a: readonly T[]): T =>
  a[Math.floor(Math.random() * a.length)]!;
const FIRST = [
  "Ada",
  "Alan",
  "Grace",
  "Linus",
  "Margaret",
  "Dennis",
  "Barbara",
  "Ken",
  "Radia",
  "Tim",
];
const LAST = [
  "Lovelace",
  "Turing",
  "Hopper",
  "Torvalds",
  "Hamilton",
  "Ritchie",
  "Liskov",
  "Thompson",
  "Perlman",
  "Lee",
];
const WORDS = [
  "lorem",
  "ipsum",
  "dolor",
  "vector",
  "matrix",
  "quantum",
  "photon",
  "cipher",
  "delta",
  "nimbus",
];

function uuid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** name → (generator, human description). Exposed for autocomplete/highlighting. */
export const DYNAMIC_VARS: Record<string, { gen: () => string; desc: string }> =
  {
    $uuid: { gen: uuid, desc: "random UUID v4" },
    $guid: { gen: uuid, desc: "random UUID v4 (alias)" },
    $timestamp: {
      gen: () => String(Math.floor(Date.now() / 1000)),
      desc: "unix time (seconds)",
    },
    $isoTimestamp: {
      gen: () => new Date().toISOString(),
      desc: "ISO-8601 datetime",
    },
    $randomInt: { gen: () => String(randInt(0, 1000)), desc: "integer 0–1000" },
    $randomEmail: {
      gen: () =>
        `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${randInt(1, 999)}@example.com`,
      desc: "random email",
    },
    $randomFirstName: { gen: () => pick(FIRST), desc: "random first name" },
    $randomLastName: { gen: () => pick(LAST), desc: "random last name" },
    $randomFullName: {
      gen: () => `${pick(FIRST)} ${pick(LAST)}`,
      desc: "random full name",
    },
    $randomWord: { gen: () => pick(WORDS), desc: "random word" },
    $randomBoolean: {
      gen: () => (Math.random() < 0.5 ? "true" : "false"),
      desc: "true / false",
    },
    $randomIP: {
      gen: () =>
        `${randInt(1, 255)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 255)}`,
      desc: "random IPv4",
    },
    $randomHexColor: {
      gen: () => "#" + randInt(0, 0xffffff).toString(16).padStart(6, "0"),
      desc: "random hex colour",
    },
  };

/** Resolve a `{{$name}}` dynamic token, or undefined if it isn't one. */
export function resolveDynamic(name: string): string | undefined {
  return DYNAMIC_VARS[name]?.gen();
}

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
      const dyn = resolveDynamic(name);
      if (dyn !== undefined) {
        changed = true;
        return dyn;
      }
      return match;
    });
    if (!changed) break;
  }
  // Whatever placeholders remain are genuinely unknown (dynamic ones are already gone).
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
const PATH_PARAM = /:([A-Za-z_][\w-]*)/g;

export function resolveRequest(
  def: RequestDefinition,
  lookup: VariableScope
): ResolvedRequest {
  const unresolved = new Set<string>();
  const url = resolveTemplate(def.url, lookup);
  url.unresolved.forEach((u) => unresolved.add(u));

  // Substitute `:name` path params (values themselves may use {{vars}}).
  const pathParams = resolveKvList(def.pathParams, lookup, unresolved);
  const pathMap: VariableScope = {};
  for (const p of pathParams) pathMap[p.name] = p.value;
  let resolvedUrl = url.value.replace(PATH_PARAM, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(pathMap, name) ? pathMap[name]! : m
  );

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

  // Resolve non-HTTP target fields and, for those kinds, surface a human target URL.
  const host = resolveTemplate(def.net.host, lookup);
  host.unresolved.forEach((u) => unresolved.add(u));
  const payload = resolveTemplate(def.net.payload, lookup);
  payload.unresolved.forEach((u) => unresolved.add(u));
  const net = { ...def.net, host: host.value, payload: payload.value };
  // http/ws/sse/grpc carry their target in `url`; the socket kinds derive it from net.*.
  if (
    def.kind !== "http" &&
    def.kind !== "ws" &&
    def.kind !== "sse" &&
    def.kind !== "grpc"
  ) {
    resolvedUrl =
      def.kind === "whois" || def.kind === "dns"
        ? net.host
        : `${net.host}:${net.port}`;
  }

  return {
    request: {
      ...def,
      url: resolvedUrl,
      headers: resolveKvList(def.headers, lookup, unresolved),
      query: resolveKvList(def.query, lookup, unresolved),
      pathParams,
      body,
      net,
      auth: resolveAuth(def.auth, lookup, unresolved),
      proxy: def.proxy ? resolveTemplate(def.proxy, lookup).value : def.proxy,
    },
    unresolved: [...unresolved],
  };
}
