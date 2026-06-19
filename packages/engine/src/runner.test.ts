import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { newRequest, type RequestDefinition } from "@red-request/core";
import { runLoop } from "./runner.js";

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
      })
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const req = (p: Partial<RequestDefinition>): RequestDefinition => ({
  ...newRequest("r"),
  ...p,
});

describe("runLoop", () => {
  it("repeat runs N times", async () => {
    const r = await runLoop({
      mode: "repeat",
      count: 3,
      variables: {},
      request: req({ method: "GET", url: `${base}/x` }),
    });
    expect(r.iterations).toHaveLength(3);
    expect(r.aggregate.total).toBe(3);
    expect(r.aggregate.okCount).toBe(3);
  });

  it("data-driven runs once per row with row vars", async () => {
    const r = await runLoop({
      mode: "data",
      variables: {},
      dataset: [{ v: "a" }, { v: "b" }],
      request: req({
        method: "GET",
        url: `${base}/x`,
        query: [{ name: "v", value: "{{v}}", enabled: true }],
      }),
    });
    expect(r.iterations).toHaveLength(2);
    expect(JSON.parse(r.iterations[0]!.response.bodyText).query.v).toBe("a");
    expect(JSON.parse(r.iterations[1]!.response.bodyText).query.v).toBe("b");
  });

  it("flow threads a setVar from one request into the next", async () => {
    const r = await runLoop({
      mode: "flow",
      variables: {},
      requests: [
        req({
          id: "a",
          name: "A",
          method: "GET",
          url: `${base}/first`,
          scripts: {
            preRequest: "",
            postResponse: "rr.setVar('p', rr.res.json.path)",
          },
        }),
        req({
          id: "b",
          name: "B",
          method: "GET",
          url: `${base}/second`,
          query: [{ name: "from", value: "{{p}}", enabled: true }],
        }),
      ],
    });
    expect(r.iterations).toHaveLength(2);
    expect(JSON.parse(r.iterations[1]!.response.bodyText).query.from).toBe(
      "/first"
    );
  });
});
