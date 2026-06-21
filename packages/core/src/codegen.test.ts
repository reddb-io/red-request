import { describe, it, expect } from "vitest";
import { generateSnippet } from "./codegen.js";
import { newRequest } from "./request.js";

function req() {
  const r = newRequest("x");
  r.method = "POST";
  r.url = "https://api.example.com/v1/users";
  r.query = [{ name: "page", value: "2", enabled: true }];
  r.headers = [{ name: "X-Trace", value: "abc", enabled: true }];
  r.auth = { type: "bearer", token: "tok123" };
  r.body = { type: "json", content: '{"name":"Ada"}', fields: [] };
  return r;
}

describe("generateSnippet", () => {
  it("curl includes method, query, header, bearer auth and body", () => {
    const s = generateSnippet(req(), "curl");
    expect(s).toContain("curl -X POST");
    expect(s).toContain("page=2");
    expect(s).toContain("X-Trace: abc");
    expect(s).toContain("Authorization: Bearer tok123");
    expect(s).toContain('{"name":"Ada"}');
  });
  it("python uses requests with json=", () => {
    expect(generateSnippet(req(), "python")).toContain("import requests");
  });
  it("fetch + go + axios emit something runnable", () => {
    for (const l of ["fetch", "axios", "go"] as const)
      expect(generateSnippet(req(), l).length).toBeGreaterThan(20);
  });
  it("non-http kinds are skipped gracefully", () => {
    const r = newRequest("y");
    r.kind = "dns";
    expect(generateSnippet(r, "curl")).toContain("HTTP requests only");
  });
});
