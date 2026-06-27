import { describe, it, expect } from "vitest";
import { generateSnippet, SNIPPET_LANGS } from "./codegen.js";
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
  it("recker CLI: emits rek POST … with --json body, query, headers", () => {
    const s = generateSnippet(req(), "recker");
    // It should look like a real `rek` invocation, not curl.
    expect(s).toContain("rek POST");
    expect(s).toContain("api.example.com/v1/users");
    // Query is appended in the URL by buildModel — no -d flag for it.
    expect(s).toContain("page=2");
    expect(s).toContain("-H");
    expect(s).toContain("X-Trace: abc");
    expect(s).toContain("Authorization: Bearer tok123");
    // JSON body uses --json (not --data) so recker knows to set content-type.
    expect(s).toContain("--json");
    expect(s).toContain('{"name":"Ada"}');
    expect(s).not.toContain("curl");
  });
  it("recker CLI: rewrites Basic auth into -u user:pass instead of base64", () => {
    const r = req();
    r.auth = { type: "basic", username: "ada", password: "lovelace" };
    const s = generateSnippet(r, "recker");
    expect(s).toContain("-u 'ada:lovelace'");
    // And the redundant Authorization header is dropped.
    expect(s).not.toContain("Authorization:");
  });
  it("recker CLI: GET is omitted (verb defaults to GET)", () => {
    const r = req();
    r.method = "GET";
    delete (r as { body?: unknown }).body;
    r.body = { type: "none", content: "", fields: [] };
    const s = generateSnippet(r, "recker");
    expect(s).toMatch(/rek https:\/\/api/);
    expect(s).not.toContain("GET ");
  });
  it("recker CLI is exposed in the language picker", () => {
    expect(SNIPPET_LANGS.find((l) => l.id === "recker")).toBeTruthy();
  });
  it("non-http kinds are skipped gracefully", () => {
    const r = newRequest("y");
    r.kind = "dns";
    expect(generateSnippet(r, "curl")).toContain("HTTP requests only");
  });
});
