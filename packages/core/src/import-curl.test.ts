import { describe, it, expect } from "vitest";
import { curlToRequest, tokenizeCurl } from "./import-curl.js";

describe("tokenizeCurl", () => {
  it("honors quotes and line continuations", () => {
    expect(tokenizeCurl("curl 'https://x.io/a b' \\\n  -H \"K: V\"")).toEqual([
      "curl",
      "https://x.io/a b",
      "-H",
      "K: V",
    ]);
  });
});

describe("curlToRequest", () => {
  it("parses a GET with headers", () => {
    const r = curlToRequest(
      "curl https://api.test/users -H 'Accept: application/json'",
      "r1"
    );
    expect(r.method).toBe("GET");
    expect(r.url).toBe("https://api.test/users");
    expect(r.headers).toContainEqual({
      name: "Accept",
      value: "application/json",
      enabled: true,
    });
  });

  it("infers POST + json body from --data", () => {
    const r = curlToRequest(
      `curl -X POST https://api.test/users -H 'content-type: application/json' --data '{"name":"ada"}'`,
      "r2"
    );
    expect(r.method).toBe("POST");
    expect(r.body.type).toBe("json");
    expect(r.body.content).toBe('{"name":"ada"}');
  });

  it("infers POST when data is present without -X", () => {
    const r = curlToRequest("curl https://x.io -d hello=1", "r3");
    expect(r.method).toBe("POST");
    expect(r.body.content).toBe("hello=1");
  });

  it("maps -u to basic auth and --url", () => {
    const r = curlToRequest("curl --url https://x.io -u ada:secret", "r4");
    expect(r.url).toBe("https://x.io");
    expect(r.auth).toMatchObject({
      type: "basic",
      username: "ada",
      password: "secret",
    });
  });

  it("skips unknown flags like --compressed/-L", () => {
    const r = curlToRequest("curl --compressed -L https://x.io/p", "r5");
    expect(r.url).toBe("https://x.io/p");
    expect(r.method).toBe("GET");
  });
});
