import { describe, it, expect } from "vitest";
import {
  mergeScopes,
  resolveTemplate,
  resolveRequest,
  resolveDynamic,
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
