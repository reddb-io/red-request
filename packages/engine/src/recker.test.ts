import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { newRequest, type RequestDefinition } from "@reddb-io/request-core";
import { dispatch } from "./recker.js";

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", base);
      if (url.pathname === "/notfound") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
        return;
      }
      if (url.pathname === "/needauth") {
        const ok = req.headers["authorization"] === "Bearer abc123";
        res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            authorized: ok,
            seen: req.headers["authorization"] ?? null,
          })
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          method: req.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: req.headers,
          body,
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function req(partial: Partial<RequestDefinition>): RequestDefinition {
  return { ...newRequest("t"), ...partial };
}

describe("dispatch", () => {
  it("GET maps status, headers, body and timings", async () => {
    const r = await dispatch(
      req({
        method: "GET",
        url: `${base}/get`,
        query: [{ name: "a", value: "1", enabled: true }],
        headers: [{ name: "X-Custom", value: "yo", enabled: true }],
      })
    );
    expect(r.status).toBe(200);
    expect(r.ok).toBe(true);
    expect(r.headers["content-type"]).toContain("application/json");
    expect(r.timings).toBeDefined();
    const echoed = JSON.parse(r.bodyText);
    expect(echoed.method).toBe("GET");
    expect(echoed.query).toEqual({ a: "1" });
    expect(echoed.headers["x-custom"]).toBe("yo");
  });

  it("POST sends a JSON body", async () => {
    const r = await dispatch(
      req({
        method: "POST",
        url: `${base}/post`,
        body: { type: "json", content: '{"hello":"world"}', fields: [] },
      })
    );
    expect(r.status).toBe(200);
    const echoed = JSON.parse(r.bodyText);
    expect(JSON.parse(echoed.body)).toEqual({ hello: "world" });
    expect(echoed.headers["content-type"]).toContain("application/json");
  });

  it("returns 4xx as a normal result (does not throw)", async () => {
    const r = await dispatch(req({ method: "GET", url: `${base}/notfound` }));
    expect(r.status).toBe(404);
    expect(r.ok).toBe(false);
    expect(JSON.parse(r.bodyText).error).toBe("nope");
  });

  it("applies bearer auth", async () => {
    const r = await dispatch(
      req({
        method: "GET",
        url: `${base}/needauth`,
        auth: { type: "bearer", token: "abc123" },
      })
    );
    expect(r.status).toBe(200);
    expect(JSON.parse(r.bodyText).authorized).toBe(true);
  });

  it("produces an error result on connection failure", async () => {
    const r = await dispatch(
      req({ method: "GET", url: "http://127.0.0.1:1/dead" })
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBeTruthy();
  });

  it("sends GraphQL query and variables as a single JSON payload", async () => {
    const r = await dispatch(
      req({
        method: "POST",
        url: `${base}/graphql`,
        body: {
          type: "graphql",
          content: "query Viewer($id: ID!) { viewer(id: $id) { name } }",
          variables: '{"id":"u-1"}',
          fields: [],
        },
      })
    );
    expect(r.status).toBe(200);
    const echoed = JSON.parse(r.bodyText);
    const payload = JSON.parse(echoed.body);
    expect(payload.query).toBe(
      "query Viewer($id: ID!) { viewer(id: $id) { name } }"
    );
    expect(payload.variables).toEqual({ id: "u-1" });
    expect(echoed.headers["content-type"]).toContain("application/json");
  });

  it("sends GraphQL with empty variables object when variables field is absent", async () => {
    const r = await dispatch(
      req({
        method: "POST",
        url: `${base}/graphql`,
        body: {
          type: "graphql",
          content: "query { viewer { id } }",
          fields: [],
        },
      })
    );
    expect(r.status).toBe(200);
    const payload = JSON.parse(JSON.parse(r.bodyText).body);
    expect(payload.variables).toEqual({});
  });
});
