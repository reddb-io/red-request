// Pre-request / post-response script sandbox. Scripts are the user's own JS, running on
// the user's machine (like Bruno/Postman), so we run them with `new Function` rather than
// a hardened VM — the goal is capability, not isolation. The `rr` object is the API.
import type {
  RequestDefinition,
  ResponseResult,
  ScriptTest,
} from "@red-request/core";

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Run user code with `rr` + a captured `console`. Returns an error message or undefined. */
async function run(
  code: string,
  rr: unknown,
  logs: string[]
): Promise<string | undefined> {
  if (!code.trim()) return undefined;
  const sandboxConsole = {
    log: (...a: unknown[]) => logs.push(a.map(fmt).join(" ")),
    info: (...a: unknown[]) => logs.push(a.map(fmt).join(" ")),
    warn: (...a: unknown[]) => logs.push("WARN " + a.map(fmt).join(" ")),
    error: (...a: unknown[]) => logs.push("ERROR " + a.map(fmt).join(" ")),
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(
      "rr",
      "console",
      `return (async () => {\n${code}\n})()`
    );
    await fn(rr, sandboxConsole);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Jest-ish matchers; each throws on failure (caught by rr.test or surfaced as error). */
function makeExpect() {
  return (actual: unknown) => {
    const ok = (passed: boolean, msg: string) => {
      if (!passed) throw new Error(msg);
    };
    return {
      toBe: (e: unknown) =>
        ok(actual === e, `expected ${fmt(actual)} to be ${fmt(e)}`),
      toEqual: (e: unknown) =>
        ok(
          JSON.stringify(actual) === JSON.stringify(e),
          `expected ${fmt(actual)} to equal ${fmt(e)}`
        ),
      toContain: (e: unknown) =>
        ok(
          typeof actual === "string"
            ? actual.includes(String(e))
            : Array.isArray(actual) && actual.includes(e),
          `expected ${fmt(actual)} to contain ${fmt(e)}`
        ),
      toBeTruthy: () => ok(!!actual, `expected ${fmt(actual)} to be truthy`),
      toBeFalsy: () => ok(!actual, `expected ${fmt(actual)} to be falsy`),
      toBeGreaterThan: (n: number) =>
        ok(Number(actual) > n, `expected ${fmt(actual)} > ${n}`),
      toBeLessThan: (n: number) =>
        ok(Number(actual) < n, `expected ${fmt(actual)} < ${n}`),
    };
  };
}

export interface PreResult {
  logs: string[];
  error?: string;
}

export interface PostResult {
  logs: string[];
  tests: ScriptTest[];
  varChanges: Record<string, string>;
  error?: string;
}

/** Runs the pre-request script. Mutates `def` (method/url/headers) and `vars` in place. */
export async function runPreRequest(
  def: RequestDefinition,
  vars: Record<string, string>
): Promise<PreResult> {
  const logs: string[] = [];
  const code = def.scripts?.preRequest ?? "";
  if (!code.trim()) return { logs };

  const rr = {
    req: {
      get method() {
        return def.method;
      },
      set method(m: string) {
        def.method = m as RequestDefinition["method"];
      },
      get url() {
        return def.url;
      },
      set url(u: string) {
        def.url = u;
      },
    },
    setHeader(name: string, value: string) {
      const h = def.headers.find(
        (x) => x.name.toLowerCase() === name.toLowerCase()
      );
      if (h) {
        h.value = value;
        h.enabled = true;
      } else {
        def.headers.push({ name, value, enabled: true });
      }
    },
    getHeader: (name: string) =>
      def.headers.find((x) => x.name.toLowerCase() === name.toLowerCase())
        ?.value,
    setVar: (k: string, v: unknown) => {
      vars[k] = String(v);
    },
    getVar: (k: string) => vars[k],
    env: vars,
  };
  const error = await run(code, rr, logs);
  return { logs, error };
}

/** Runs the post-response script. Collects tests, console logs and variable changes. */
export async function runPostResponse(
  code: string,
  response: ResponseResult,
  vars: Record<string, string>
): Promise<PostResult> {
  const logs: string[] = [];
  const tests: ScriptTest[] = [];
  const varChanges: Record<string, string> = {};
  if (!code.trim()) return { logs, tests, varChanges };

  let json: unknown = null;
  try {
    json = JSON.parse(response.bodyText);
  } catch {
    /* not json */
  }

  const rr = {
    res: {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.bodyText,
      json,
      time: response.durationMs,
      ok: response.ok,
    },
    expect: makeExpect(),
    // Synchronous so results are recorded in order before the script returns.
    test(name: string, fn: () => unknown) {
      try {
        fn();
        tests.push({ name, passed: true });
      } catch (e) {
        tests.push({
          name,
          passed: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    },
    setVar: (k: string, v: unknown) => {
      varChanges[k] = String(v);
      vars[k] = String(v);
    },
    getVar: (k: string) => vars[k],
    env: vars,
  };
  const error = await run(code, rr, logs);
  return { logs, tests, varChanges, error };
}
