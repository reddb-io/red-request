import type { RequestDefinition, Kv } from "./request.js";
import type { AuthConfig } from "./auth.js";

/** A flat name→value map. */
export type VariableScope = Record<string, string>;

type TemplateFunctionArgs = readonly string[];
type ZeroArgTemplateFunction = {
  gen: () => string;
  desc: string;
  args: TemplateFunctionArgs;
};
type TemplateFunctionWithArgs = {
  apply: (args: FnArg[]) => string | undefined;
  desc: string;
  args: TemplateFunctionArgs;
};

export type TemplateFunctionCatalogEntry = {
  name: string;
  args: TemplateFunctionArgs;
  signature: string;
  desc: string;
};

// Matches both flat variable tokens (`{{var}}`, group 1) and namespaced
// function-call tokens (`{{ns.fn(args)}}`). Group 1 is the name; group 2, when
// present, is the raw argument source between the parentheses (empty for `()`).
// The argument source forbids `}` so the greedy capture can never span past the
// token's own closing `}}` into a neighbouring token; literal args never contain
// `}` (no nested interpolation in this version).
const PLACEHOLDER = /\{\{\s*([\w.$-]+)\s*(?:\(([^}]*)\))?\s*\}\}/g;
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

// ---------------------------------------------------------------------------
// Function-call interpolation — namespaced `{{ns.fn()}}` tokens dispatched
// through a registry and generated fresh on every resolve (never stored). This
// slice ships the zero-argument `rand.*` catalog; the argument grammar and
// parameterized functions land in a later slice.
// ---------------------------------------------------------------------------

/**
 * namespace.name → (generator, human description). Exposed for downstream use
 * (autocomplete/highlighting will consume the catalog). Every entry here is
 * zero-arg and called with empty `()`.
 */
export const TEMPLATE_FUNCTIONS: Record<string, ZeroArgTemplateFunction> = {
  "rand.uuid": { gen: uuid, desc: "random UUID v4", args: [] },
  "rand.guid": { gen: uuid, desc: "random UUID v4 (alias)", args: [] },
  "rand.email": {
    gen: () =>
      `${pick(FIRST).toLowerCase()}.${pick(LAST).toLowerCase()}${randInt(1, 999)}@example.com`,
    desc: "random email",
    args: [],
  },
  "rand.username": {
    gen: () =>
      `${pick(FIRST).toLowerCase()}${pick(LAST).toLowerCase()}${randInt(1, 999)}`,
    desc: "random username",
    args: [],
  },
  "rand.firstName": {
    gen: () => pick(FIRST),
    desc: "random first name",
    args: [],
  },
  "rand.lastName": {
    gen: () => pick(LAST),
    desc: "random last name",
    args: [],
  },
  "rand.fullName": {
    gen: () => `${pick(FIRST)} ${pick(LAST)}`,
    desc: "random full name",
    args: [],
  },
  "rand.word": { gen: () => pick(WORDS), desc: "random word", args: [] },
  "rand.bool": {
    gen: () => (Math.random() < 0.5 ? "true" : "false"),
    desc: "true / false",
    args: [],
  },
  "rand.ip": {
    gen: () =>
      `${randInt(1, 255)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 255)}`,
    desc: "random IPv4",
    args: [],
  },
  "rand.hexColor": {
    gen: () => "#" + randInt(0, 0xffffff).toString(16).padStart(6, "0"),
    desc: "random hex colour",
    args: [],
  },
};

/** Resolve a zero-arg `{{ns.fn()}}` function token, or undefined if unknown. */
export function resolveFunction(name: string): string | undefined {
  return TEMPLATE_FUNCTIONS[name]?.gen();
}

// ---------------------------------------------------------------------------
// Argument grammar — parameterized `{{ns.fn(arg,arg,...)}}` tokens. Arguments
// are literals only (no nested interpolation): integers/floats, single-quoted
// strings, and a variadic comma-separated list. Parsing is total: malformed
// input yields an `{ok:false}` result rather than throwing, so a bad token is
// left verbatim and reported as unresolved.
// ---------------------------------------------------------------------------

/** A parsed literal argument. */
export type FnArg = number | string;

export type ParsedArgs =
  | { ok: true; args: FnArg[] }
  | { ok: false; error: string };

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const WS = /\s/;

/**
 * Parse a raw argument source (the text between `(` and `)`) into literals.
 * Accepts integers, floats, and single-quoted strings (with `\'`/`\\` escapes),
 * separated by commas and tolerant of surrounding whitespace. Returns a tagged
 * result; never throws.
 */
export function parseArgs(source: string): ParsedArgs {
  const s = source;
  const n = s.length;
  const args: FnArg[] = [];
  let i = 0;

  const skipWs = () => {
    while (i < n && WS.test(s[i]!)) i++;
  };

  skipWs();
  if (i >= n) return { ok: true, args };

  while (true) {
    skipWs();
    if (i >= n) return { ok: false, error: "missing argument" };

    if (s[i] === "'") {
      // Single-quoted string literal.
      i++;
      let str = "";
      let closed = false;
      while (i < n) {
        const ch = s[i]!;
        if (ch === "\\" && i + 1 < n) {
          str += s[i + 1];
          i += 2;
          continue;
        }
        if (ch === "'") {
          closed = true;
          i++;
          break;
        }
        str += ch;
        i++;
      }
      if (!closed) return { ok: false, error: "unterminated string" };
      args.push(str);
    } else {
      // Numeric literal: consume up to the next comma.
      let tok = "";
      while (i < n && s[i] !== ",") {
        tok += s[i];
        i++;
      }
      tok = tok.trim();
      if (!NUMERIC.test(tok)) {
        return { ok: false, error: `non-numeric argument: '${tok}'` };
      }
      args.push(Number(tok));
    }

    skipWs();
    if (i >= n) return { ok: true, args };
    if (s[i] !== ",") {
      return { ok: false, error: `unexpected token: '${s[i]}'` };
    }
    i++; // consume comma, expect another argument
  }
}

const ALPHANUM =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const HEX = "0123456789abcdef";

const randString = (len: number, alphabet: string): string => {
  let out = "";
  for (let k = 0; k < len; k++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
};

const isLen = (a: FnArg | undefined): a is number =>
  typeof a === "number" && Number.isInteger(a) && a >= 0;

// ---------------------------------------------------------------------------
// datetime.* offsets — a relative offset token of the form `[+-]N[smhdwMy]`
// (seconds, minutes, hours, days, weeks, months, years) applied to a base date.
// Offsets arrive as single-quoted string literals via the argument grammar.
// Parsing is total: a malformed token yields `undefined` (the caller leaves the
// token unresolved) and never throws.
// ---------------------------------------------------------------------------

const OFFSET = /^([+-])(\d+)([smhdwMy])$/;
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Apply a relative offset token to `base`, returning a new Date, or `undefined`
 * for a malformed token. Months (`M`) and years (`y`) shift the calendar fields
 * so e.g. `+1M` lands on the same day-of-month next month; the sub-month units
 * use exact millisecond arithmetic.
 */
export function applyOffset(base: Date, token: string): Date | undefined {
  const m = OFFSET.exec(token);
  if (!m) return undefined;
  const n = (m[1] === "-" ? -1 : 1) * Number(m[2]);
  const unit = m[3]!;
  if (unit === "M") {
    const d = new Date(base.getTime());
    d.setUTCMonth(d.getUTCMonth() + n);
    return d;
  }
  if (unit === "y") {
    const d = new Date(base.getTime());
    d.setUTCFullYear(d.getUTCFullYear() + n);
    return d;
  }
  return new Date(base.getTime() + n * UNIT_MS[unit]!);
}

const pad = (n: number, len = 2): string => String(n).padStart(len, "0");

/** Format a date (UTC) using a small token vocabulary for `datetime.now`. */
function formatDate(d: Date, fmt: string): string {
  return fmt.replace(/YYYY|MM|DD|HH|mm|ss|SSS/g, (tok) => {
    switch (tok) {
      case "YYYY":
        return pad(d.getUTCFullYear(), 4);
      case "MM":
        return pad(d.getUTCMonth() + 1);
      case "DD":
        return pad(d.getUTCDate());
      case "HH":
        return pad(d.getUTCHours());
      case "mm":
        return pad(d.getUTCMinutes());
      case "ss":
        return pad(d.getUTCSeconds());
      case "SSS":
        return pad(d.getUTCMilliseconds(), 3);
      default:
        return tok;
    }
  });
}

/**
 * Resolve a base "now" date, optionally shifted by a single offset argument.
 * Returns `undefined` when an offset is supplied but malformed or non-string.
 */
function nowWithOffset(offsetArg: FnArg | undefined): Date | undefined {
  const base = new Date();
  if (offsetArg === undefined) return base;
  if (typeof offsetArg !== "string") return undefined;
  return applyOffset(base, offsetArg);
}

/** Build a `datetime.*` entry that emits `now` (optionally offset) via `fmt`. */
const datetimeFn = (
  fmt: (d: Date) => string,
  desc: string
): TemplateFunctionWithArgs => ({
  desc,
  args: ["offset?"],
  apply: (args) => {
    if (args.length > 1) return undefined;
    const d = nowWithOffset(args[0]);
    return d ? fmt(d) : undefined;
  },
});

/**
 * namespace.name → (apply, human description) for parameterized functions. Each
 * `apply` validates arity/types itself and returns `undefined` on any malformed
 * call so the resolver can leave the token unresolved.
 */
export const TEMPLATE_FUNCTIONS_WITH_ARGS: Record<
  string,
  TemplateFunctionWithArgs
> = {
  "rand.int": {
    desc: "random integer in [min,max]",
    args: ["min", "max"],
    apply: (args) => {
      if (args.length !== 2) return undefined;
      const [min, max] = args;
      if (typeof min !== "number" || typeof max !== "number") return undefined;
      const lo = Math.ceil(min);
      const hi = Math.floor(max);
      if (hi < lo) return undefined;
      return String(randInt(lo, hi));
    },
  },
  "rand.float": {
    desc: "random float in [min,max)",
    args: ["min", "max"],
    apply: (args) => {
      if (args.length !== 2) return undefined;
      const [min, max] = args;
      if (typeof min !== "number" || typeof max !== "number") return undefined;
      if (max < min) return undefined;
      return String(Math.random() * (max - min) + min);
    },
  },
  "rand.string": {
    desc: "random alphanumeric string of length len",
    args: ["len"],
    apply: (args) => {
      if (args.length !== 1 || !isLen(args[0])) return undefined;
      return randString(args[0], ALPHANUM);
    },
  },
  "rand.hex": {
    desc: "random hex string of length len",
    args: ["len"],
    apply: (args) => {
      if (args.length !== 1 || !isLen(args[0])) return undefined;
      return randString(args[0], HEX);
    },
  },
  "rand.pick": {
    desc: "random pick from the given literal arguments",
    args: ["value", "...values"],
    apply: (args) => {
      if (args.length < 1) return undefined;
      return String(pick(args));
    },
  },
  "datetime.iso8601": datetimeFn(
    (d) => d.toISOString(),
    "current time, ISO-8601 / RFC-3339 (offset?)"
  ),
  "datetime.unix": datetimeFn(
    (d) => String(Math.floor(d.getTime() / 1000)),
    "current unix time in seconds (offset?)"
  ),
  "datetime.unixMs": datetimeFn(
    (d) => String(d.getTime()),
    "current unix time in milliseconds (offset?)"
  ),
  "datetime.date": datetimeFn(
    (d) => d.toISOString().slice(0, 10),
    "current date, YYYY-MM-DD (offset?)"
  ),
  "datetime.time": datetimeFn(
    (d) => d.toISOString().slice(11, 19),
    "current time, HH:MM:SS (offset?)"
  ),
  "datetime.now": {
    desc: "current time in a custom format (format?, offset?)",
    args: ["format?", "offset?"],
    apply: (args) => {
      if (args.length > 2) return undefined;
      const [fmt, offset] = args;
      if (fmt !== undefined && typeof fmt !== "string") return undefined;
      if (offset !== undefined && typeof offset !== "string") return undefined;
      const d = nowWithOffset(offset);
      if (!d) return undefined;
      return fmt === undefined ? d.toISOString() : formatDate(d, fmt);
    },
  },
};

export const TEMPLATE_FUNCTION_CATALOG: readonly TemplateFunctionCatalogEntry[] =
  Object.freeze(
    [
      ...Object.entries(TEMPLATE_FUNCTIONS),
      ...Object.entries(TEMPLATE_FUNCTIONS_WITH_ARGS),
    ]
      .map(([name, fn]) => ({
        name,
        args: fn.args,
        signature: `${name}(${fn.args.join(", ")})`,
        desc: fn.desc,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  );

/**
 * Resolve a `{{ns.fn(source)}}` call. `source` is the raw text between the
 * parens. Returns the generated value, or undefined if the args are malformed
 * or the function/arity is unknown (caller leaves the token verbatim).
 */
export function resolveFunctionCall(
  name: string,
  source: string
): string | undefined {
  const parsed = parseArgs(source);
  if (!parsed.ok) return undefined;
  // With no arguments, prefer the zero-arg catalog; functions whose arguments
  // are all optional (e.g. `datetime.*`) live only in the parameterized catalog,
  // so fall through to it with an empty argument list.
  if (parsed.args.length === 0) {
    const zero = TEMPLATE_FUNCTIONS[name];
    if (zero) return zero.gen();
  }
  return TEMPLATE_FUNCTIONS_WITH_ARGS[name]?.apply(parsed.args);
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
    value = value.replace(
      PLACEHOLDER,
      (match, name: string, args: string | undefined) => {
        // A trailing `(…)` marks a function-call token; dispatch through the
        // registry, parsing any literal arguments first.
        if (args !== undefined) {
          const fn = resolveFunctionCall(name, args);
          if (fn !== undefined) {
            changed = true;
            return fn;
          }
          return match;
        }
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
      }
    );
    if (!changed) break;
  }
  // Whatever placeholders remain are genuinely unknown (resolved dynamic/function
  // tokens are already gone). Report function tokens with their `()` so they read
  // distinctly from unknown variables.
  for (const m of value.matchAll(PLACEHOLDER)) {
    if (m[1]) {
      unresolved.add(m[2] !== undefined ? `${m[1]}(${m[2].trim()})` : m[1]);
    }
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
