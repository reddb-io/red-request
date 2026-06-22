import { describe, it, expect } from "vitest";
import {
  mergeScopes,
  resolveTemplate,
  resolveRequest,
  resolveDynamic,
  resolveFunction,
  parseArgs,
  applyOffset,
  TEMPLATE_FUNCTIONS,
  TEMPLATE_FUNCTIONS_WITH_ARGS,
} from "./resolver.js";
import { newRequest } from "./request.js";

describe("dynamic variables", () => {
  it("resolves {{$…}} tokens without a scope and never reports them unresolved", () => {
    const r = resolveTemplate("id={{$uuid}}&t={{$timestamp}}&x={{nope}}", {});
    expect(r.value).toMatch(/^id=[0-9a-f-]{36}&t=\d{10}&x=\{\{nope\}\}$/);
    expect(r.unresolved).toEqual(["nope"]);
  });
  it("each occurrence is independent", () => {
    const [a, b] = resolveTemplate("{{$uuid}} {{$uuid}}", {}).value.split(" ");
    expect(a).not.toBe(b);
  });
  it("a real scope var wins over a dynamic name; unknown $tokens are undefined", () => {
    expect(
      resolveTemplate("{{$timestamp}}", { $timestamp: "fixed" }).value
    ).toBe("fixed");
    expect(resolveDynamic("$randomEmail")).toMatch(/@example\.com$/);
    expect(resolveDynamic("$nope")).toBeUndefined();
  });
});

describe("function-call interpolation", () => {
  const PATTERNS: Record<string, RegExp> = {
    "rand.uuid":
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "rand.guid":
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "rand.email": /^[a-z]+\.[a-z]+\d{1,3}@example\.com$/,
    "rand.username": /^[a-z]+\d{1,3}$/,
    "rand.firstName": /^[A-Z][a-z]+$/,
    "rand.lastName": /^[A-Z][a-z]+$/,
    "rand.fullName": /^[A-Z][a-z]+ [A-Z][a-z]+$/,
    "rand.word": /^[a-z]+$/,
    "rand.bool": /^(true|false)$/,
    "rand.ip": /^(\d{1,3}\.){3}\d{1,3}$/,
    "rand.hexColor": /^#[0-9a-f]{6}$/,
  };

  it("the registry exposes exactly the documented zero-arg rand.* catalog", () => {
    expect(Object.keys(TEMPLATE_FUNCTIONS).sort()).toEqual(
      Object.keys(PATTERNS).sort()
    );
  });

  for (const [name, re] of Object.entries(PATTERNS)) {
    it(`{{${name}()}} resolves to a fresh value`, () => {
      const r = resolveTemplate(`{{${name}()}}`, {});
      expect(r.value).toMatch(re);
      expect(r.unresolved).toEqual([]);
      expect(resolveFunction(name)).toMatch(re);
    });
  }

  it("recognizes function tokens without breaking adjacent {{var}} resolution", () => {
    const r = resolveTemplate("u={{$uuid}} h={{ host }} w={{rand.word()}}", {
      host: "api.test",
    });
    expect(r.value).toMatch(/^u=[0-9a-f-]{36} h=api\.test w=[a-z]+$/);
    expect(r.unresolved).toEqual([]);
  });

  it("tolerates whitespace inside the token and parentheses", () => {
    const r = resolveTemplate("{{  rand.bool(  )  }}", {});
    expect(r.value).toMatch(/^(true|false)$/);
    expect(r.unresolved).toEqual([]);
  });

  it("two occurrences in one template are independent", () => {
    const [a, b] = resolveTemplate(
      "{{rand.uuid()}} {{rand.uuid()}}",
      {}
    ).value.split(" ");
    expect(a).not.toBe(b);
  });

  it("leaves an unknown function verbatim and reports it as unresolved", () => {
    const r = resolveTemplate("{{rand.nope()}}/{{rand.uuid()}}", {});
    expect(r.value).toMatch(/^\{\{rand\.nope\(\)\}\}\/[0-9a-f-]{36}$/);
    expect(r.unresolved).toEqual(["rand.nope()"]);
  });

  it("a bare {{rand.uuid}} without parens is treated as an unknown variable", () => {
    const r = resolveTemplate("{{rand.uuid}}", {});
    expect(r.value).toBe("{{rand.uuid}}");
    expect(r.unresolved).toEqual(["rand.uuid"]);
  });
});

describe("argument parser", () => {
  it("parses an empty argument list", () => {
    expect(parseArgs("")).toEqual({ ok: true, args: [] });
    expect(parseArgs("   ")).toEqual({ ok: true, args: [] });
  });

  it("parses integer and float literals", () => {
    expect(parseArgs("1")).toEqual({ ok: true, args: [1] });
    expect(parseArgs("3.14")).toEqual({ ok: true, args: [3.14] });
    expect(parseArgs("-5, +2")).toEqual({ ok: true, args: [-5, 2] });
    expect(parseArgs(".5")).toEqual({ ok: true, args: [0.5] });
  });

  it("parses single-quoted string literals, including embedded commas and parens", () => {
    expect(parseArgs("'a'")).toEqual({ ok: true, args: ["a"] });
    expect(parseArgs("'a,b'")).toEqual({ ok: true, args: ["a,b"] });
    expect(parseArgs("'a)b'")).toEqual({ ok: true, args: ["a)b"] });
    expect(parseArgs("'it\\'s'")).toEqual({ ok: true, args: ["it's"] });
  });

  it("parses a variadic, mixed, whitespace-padded list", () => {
    expect(parseArgs(" 1 , 'two' , 3.0 ")).toEqual({
      ok: true,
      args: [1, "two", 3],
    });
  });

  it("rejects non-numeric bare tokens", () => {
    expect(parseArgs("abc").ok).toBe(false);
    expect(parseArgs("1, two").ok).toBe(false);
  });

  it("rejects an unterminated string", () => {
    expect(parseArgs("'oops").ok).toBe(false);
  });

  it("rejects dangling/empty entries", () => {
    expect(parseArgs("1,").ok).toBe(false);
    expect(parseArgs("1,,2").ok).toBe(false);
    expect(parseArgs("'a' 'b'").ok).toBe(false);
  });
});

describe("parameterized rand.* functions", () => {
  it("the with-args registry exposes exactly the documented catalog", () => {
    expect(Object.keys(TEMPLATE_FUNCTIONS_WITH_ARGS).sort()).toEqual(
      [
        "rand.float",
        "rand.hex",
        "rand.int",
        "rand.pick",
        "rand.string",
        "datetime.iso8601",
        "datetime.unix",
        "datetime.unixMs",
        "datetime.date",
        "datetime.time",
        "datetime.now",
      ].sort()
    );
  });

  it("rand.int returns an integer within [min,max]", () => {
    for (let i = 0; i < 200; i++) {
      const r = resolveTemplate("{{rand.int(1,6)}}", {});
      expect(r.unresolved).toEqual([]);
      const n = Number(r.value);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(6);
    }
  });

  it("rand.float returns a float within [min,max)", () => {
    for (let i = 0; i < 200; i++) {
      const n = Number(resolveTemplate("{{rand.float(0,1)}}", {}).value);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });

  it("rand.string honours the requested length and is alphanumeric", () => {
    const r = resolveTemplate("{{rand.string(12)}}", {});
    expect(r.unresolved).toEqual([]);
    expect(r.value).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(resolveTemplate("{{rand.string(0)}}", {}).value).toBe("");
  });

  it("rand.hex honours the requested length and is hex", () => {
    const r = resolveTemplate("{{rand.hex(8)}}", {});
    expect(r.unresolved).toEqual([]);
    expect(r.value).toMatch(/^[0-9a-f]{8}$/);
  });

  it("rand.pick returns one of its arguments (variadic, mixed)", () => {
    for (let i = 0; i < 50; i++) {
      const v = resolveTemplate("{{rand.pick('a','b','c')}}", {}).value;
      expect(["a", "b", "c"]).toContain(v);
    }
    for (let i = 0; i < 50; i++) {
      const v = resolveTemplate("{{rand.pick(1,2,3)}}", {}).value;
      expect(["1", "2", "3"]).toContain(v);
    }
  });

  it("tolerates whitespace inside the call", () => {
    const n = Number(resolveTemplate("{{ rand.int( 1, 100 ) }}", {}).value);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(100);
  });

  it("leaves malformed calls unresolved without throwing", () => {
    const cases = [
      "{{rand.int(1)}}", // wrong arity
      "{{rand.int(1,2,3)}}", // wrong arity
      "{{rand.int('a',2)}}", // non-numeric where number required
      "{{rand.string(-1)}}", // invalid length
      "{{rand.string(1.5)}}", // non-integer length
      "{{rand.pick()}}", // variadic needs at least one
      "{{rand.pick('a)}}", // unterminated string
    ];
    for (const t of cases) {
      const r = resolveTemplate(t, {});
      expect(r.value).toBe(t);
      expect(r.unresolved.length).toBe(1);
    }
  });

  it("reports a malformed call with a clear, distinct signal", () => {
    const r = resolveTemplate("{{rand.int(1)}}", {});
    expect(r.unresolved).toEqual(["rand.int(1)"]);
  });

  it("two occurrences are independent", () => {
    const [a, b] = resolveTemplate(
      "{{rand.string(16)}} {{rand.string(16)}}",
      {}
    ).value.split(" ");
    expect(a).not.toBe(b);
  });
});

describe("offset parsing (applyOffset)", () => {
  const base = new Date("2026-06-22T12:00:00.000Z");

  it("shifts by each sub-month unit with exact millisecond arithmetic", () => {
    expect(applyOffset(base, "+30s")!.getTime() - base.getTime()).toBe(30_000);
    expect(applyOffset(base, "+5m")!.getTime() - base.getTime()).toBe(300_000);
    expect(applyOffset(base, "+1h")!.getTime() - base.getTime()).toBe(
      3_600_000
    );
    expect(applyOffset(base, "-7d")!.getTime() - base.getTime()).toBe(
      -7 * 86_400_000
    );
    expect(applyOffset(base, "+2w")!.getTime() - base.getTime()).toBe(
      2 * 604_800_000
    );
  });

  it("shifts months and years on the calendar", () => {
    expect(applyOffset(base, "+1M")!.toISOString()).toBe(
      "2026-07-22T12:00:00.000Z"
    );
    expect(applyOffset(base, "-1y")!.toISOString()).toBe(
      "2025-06-22T12:00:00.000Z"
    );
  });

  it("returns undefined for malformed offsets (never throws)", () => {
    for (const t of [
      "7",
      "-7q",
      "",
      "1h",
      "+h",
      "+1.5d",
      "++1d",
      "-7 d",
      "d",
    ]) {
      expect(applyOffset(base, t)).toBeUndefined();
    }
  });
});

describe("datetime.* functions", () => {
  it("the with-args registry includes the datetime catalog", () => {
    for (const k of [
      "datetime.iso8601",
      "datetime.unix",
      "datetime.unixMs",
      "datetime.date",
      "datetime.time",
      "datetime.now",
    ]) {
      expect(TEMPLATE_FUNCTIONS_WITH_ARGS[k]).toBeDefined();
    }
  });

  it("iso8601() emits a valid ISO-8601 / RFC-3339 string", () => {
    const r = resolveTemplate("{{datetime.iso8601()}}", {});
    expect(r.unresolved).toEqual([]);
    expect(r.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(r.value))).toBe(false);
  });

  it("unix() emits integer seconds and unixMs() integer milliseconds", () => {
    expect(resolveTemplate("{{datetime.unix()}}", {}).value).toMatch(/^\d+$/);
    expect(resolveTemplate("{{datetime.unixMs()}}", {}).value).toMatch(/^\d+$/);
  });

  it("date() and time() emit the date / time portions", () => {
    expect(resolveTemplate("{{datetime.date()}}", {}).value).toMatch(
      /^\d{4}-\d{2}-\d{2}$/
    );
    expect(resolveTemplate("{{datetime.time()}}", {}).value).toMatch(
      /^\d{2}:\d{2}:\d{2}$/
    );
  });

  it("an offset shifts the result by the parsed duration (relative)", () => {
    const now = Number(resolveTemplate("{{datetime.unix()}}", {}).value);
    const plus = Number(resolveTemplate("{{datetime.unix('+1h')}}", {}).value);
    // Asserted as a relative difference, never a wall-clock absolute.
    expect(plus - now).toBeGreaterThanOrEqual(3599);
    expect(plus - now).toBeLessThanOrEqual(3601);
  });

  it("now() defaults to ISO; now(format) formats with the given tokens", () => {
    expect(resolveTemplate("{{datetime.now()}}", {}).value).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    const r = resolveTemplate("{{datetime.now('YYYY-MM-DD')}}", {});
    expect(r.unresolved).toEqual([]);
    expect(r.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("now(format, offset) applies the offset before formatting", () => {
    const a = resolveTemplate(
      "{{datetime.now('YYYY-MM-DDTHH:mm:ss')}}",
      {}
    ).value;
    const b = resolveTemplate(
      "{{datetime.now('YYYY-MM-DDTHH:mm:ss','+1h')}}",
      {}
    ).value;
    const diff = (Date.parse(b + "Z") - Date.parse(a + "Z")) / 1000;
    expect(diff).toBeGreaterThanOrEqual(3599);
    expect(diff).toBeLessThanOrEqual(3601);
  });

  it("leaves an invalid offset unresolved without throwing", () => {
    for (const t of ["{{datetime.unix('7')}}", "{{datetime.iso8601('-7q')}}"]) {
      const r = resolveTemplate(t, {});
      expect(r.value).toBe(t);
      expect(r.unresolved.length).toBe(1);
    }
  });

  it("reports an invalid offset with a clear, distinct signal", () => {
    expect(resolveTemplate("{{datetime.unix('7')}}", {}).unresolved).toEqual([
      "datetime.unix('7')",
    ]);
  });

  it("two iso8601 occurrences never throw and stay resolved", () => {
    const r = resolveTemplate(
      "{{datetime.iso8601()}}|{{datetime.iso8601('-1d')}}",
      {}
    );
    expect(r.unresolved).toEqual([]);
  });
});

describe("mergeScopes", () => {
  it("gives precedence to earlier scopes", () => {
    const merged = mergeScopes([
      { host: "req.example" }, // request (wins)
      { host: "coll.example", token: "abc" }, // collection
      { token: "zzz", env: "dev" }, // environment
    ]);
    expect(merged.host).toBe("req.example");
    expect(merged.token).toBe("abc");
    expect(merged.env).toBe("dev");
  });

  it("ignores empty/missing scopes", () => {
    expect(mergeScopes([])).toEqual({});
  });
});

describe("resolveTemplate", () => {
  it("substitutes known placeholders and tolerates whitespace", () => {
    const r = resolveTemplate("https://{{ host }}/v1", { host: "api.test" });
    expect(r.value).toBe("https://api.test/v1");
    expect(r.unresolved).toEqual([]);
  });

  it("leaves unknown placeholders verbatim and reports them", () => {
    const r = resolveTemplate("{{a}}/{{b}}", { a: "1" });
    expect(r.value).toBe("1/{{b}}");
    expect(r.unresolved).toEqual(["b"]);
  });

  it("resolves nested placeholders (value contains another placeholder)", () => {
    const r = resolveTemplate("{{url}}", {
      url: "https://{{host}}",
      host: "deep.test",
    });
    expect(r.value).toBe("https://deep.test");
    expect(r.unresolved).toEqual([]);
  });

  it("does not loop forever on self-reference", () => {
    const r = resolveTemplate("{{a}}", { a: "{{a}}" });
    expect(r.value).toBe("{{a}}");
    expect(r.unresolved).toEqual(["a"]);
  });
});

describe("resolveRequest", () => {
  it("resolves url, headers, query, body and drops disabled entries", () => {
    const def = {
      ...newRequest("r1"),
      url: "https://{{host}}/users",
      headers: [
        { name: "Authorization", value: "Bearer {{token}}", enabled: true },
        { name: "X-Off", value: "{{nope}}", enabled: false },
      ],
      query: [{ name: "q", value: "{{term}}", enabled: true }],
      body: { type: "json" as const, content: '{"id":"{{id}}"}', fields: [] },
    };
    const { request, unresolved } = resolveRequest(def, {
      host: "api.test",
      token: "T0K",
      term: "hello",
      id: "42",
    });
    expect(request.url).toBe("https://api.test/users");
    expect(request.headers).toEqual([
      { name: "Authorization", value: "Bearer T0K", enabled: true },
    ]);
    expect(request.query).toEqual([
      { name: "q", value: "hello", enabled: true },
    ]);
    expect(request.body.content).toBe('{"id":"42"}');
    expect(unresolved).toEqual([]);
  });

  it("resolves auth secret placeholders and collects unresolved", () => {
    const def = {
      ...newRequest("r2"),
      url: "https://{{host}}",
      auth: { type: "bearer" as const, token: "{{API_KEY}}" },
    };
    const { request, unresolved } = resolveRequest(def, { host: "x.test" });
    expect(request.auth).toEqual({ type: "bearer", token: "{{API_KEY}}" });
    expect(unresolved.sort()).toEqual(["API_KEY"]);
  });
});
