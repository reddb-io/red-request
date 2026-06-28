import { describe, it, expect } from "vitest";
import { newRequest, type ResponseResult } from "@reddb-io/request-core";
import { runPreRequest, runPostResponse } from "./sandbox.js";

describe("runPreRequest", () => {
  it("mutates headers, url, method and sets vars", async () => {
    const def = {
      ...newRequest("r"),
      method: "GET" as const,
      url: "https://api.test",
      scripts: {
        preRequest: `
          rr.setHeader('X-Sig', 'abc');
          rr.req.method = 'POST';
          rr.setVar('ts', '123');
          console.log('pre ran');
        `,
        postResponse: "",
      },
    };
    const vars: Record<string, string> = {};
    const res = await runPreRequest(def, vars);
    expect(res.error).toBeUndefined();
    expect(def.method).toBe("POST");
    expect(def.headers.find((h) => h.name === "X-Sig")?.value).toBe("abc");
    expect(vars.ts).toBe("123");
    expect(res.logs).toContain("pre ran");
  });

  it("is a no-op for an empty script", async () => {
    const def = newRequest("r");
    const res = await runPreRequest(def, {});
    expect(res.logs).toEqual([]);
    expect(res.error).toBeUndefined();
  });
});

const fakeRes: ResponseResult = {
  status: 200,
  statusText: "OK",
  ok: true,
  url: "https://api.test",
  headers: { "content-type": "application/json" },
  bodyText: '{"token":"T0K","n":5}',
  size: 20,
  durationMs: 12,
};

describe("runPostResponse", () => {
  it("records passing and failing tests", async () => {
    const code = `
      rr.test('status is 200', () => rr.expect(rr.res.status).toBe(200));
      rr.test('has token', () => rr.expect(rr.res.json.token).toBe('T0K'));
      rr.test('fails on purpose', () => rr.expect(rr.res.json.n).toBe(99));
    `;
    const { tests, error } = await runPostResponse(code, fakeRes, {});
    expect(error).toBeUndefined();
    expect(tests.map((t) => t.passed)).toEqual([true, true, false]);
    expect(tests[2]?.error).toMatch(/to be/);
  });

  it("extracts a variable via setVar", async () => {
    const code = `rr.setVar('token', rr.res.json.token);`;
    const vars: Record<string, string> = {};
    const { varChanges } = await runPostResponse(code, fakeRes, vars);
    expect(varChanges.token).toBe("T0K");
    expect(vars.token).toBe("T0K");
  });

  it("surfaces a thrown error (bare expect failure)", async () => {
    const { error } = await runPostResponse(
      `rr.expect(rr.res.status).toBe(500);`,
      fakeRes,
      {}
    );
    expect(error).toMatch(/to be/);
  });
});
