import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { newRequest, type RequestDefinition } from "@red-request/core";
import * as repo from "./repo";

const reply = (status: number, body: unknown) => ({
  status,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

function rqlOk(records: Array<Record<string, unknown>> = []) {
  return reply(200, {
    ok: true,
    data: {
      columns: Object.keys(records[0] ?? {}),
      records,
    },
  });
}

function kvRow(key: string, value: unknown) {
  return { key, value: JSON.stringify(value) };
}

function request(id: string, patch: Partial<RequestDefinition> = {}) {
  return { ...newRequest(id), ...patch };
}

function requestDoc(colId: string, req: RequestDefinition) {
  return {
    record_type: "request",
    app_key: `${colId}.${req.id}`,
    collection_id: colId,
    request_id: req.id,
    request_name: req.name,
    request_kind: req.kind,
    request: req,
  };
}

function ipc(handlers: {
  rql?: (query: string) => unknown;
  request?: (method: string, path: string, body: string | null) => unknown;
}) {
  mockIPC((cmd, args) => {
    const a = args as Record<string, unknown>;
    if (cmd === "reddb_rql") return handlers.rql?.(a.query as string) ?? null;
    if (cmd === "reddb_request")
      return (
        handlers.request?.(
          a.method as string,
          a.path as string,
          (a.body as string | null) ?? null
        ) ?? null
      );
    return null;
  });
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("Document-backed request storage", () => {
  it("migrates legacy KV requests into the request document collection", async () => {
    const legacy = request("r1", { name: "GET users" });
    const posts: unknown[] = [];
    const ddl: string[] = [];
    let droppedRequests = false;

    ipc({
      rql: (query) => {
        if (query.startsWith("SELECT name FROM red.collections"))
          return rqlOk([]);
        if (
          query ===
          "SELECT model FROM red.collections WHERE name = 'rr_requests' LIMIT 1"
        )
          return droppedRequests ? rqlOk([]) : rqlOk([{ model: "kv" }]);
        if (
          query.startsWith("CREATE KV ") ||
          query.startsWith("CREATE DOCUMENT ") ||
          query.startsWith("ALTER TABLE ") ||
          query.startsWith("DROP COLLECTION ")
        ) {
          ddl.push(query);
          if (query === "DROP COLLECTION IF EXISTS rr_requests")
            droppedRequests = true;
          return rqlOk([{ message: "ok" }]);
        }
        if (query === "LIST KV rr_requests")
          return rqlOk([kvRow("c1.r1", legacy)]);
        if (query === "SELECT rid, body FROM rr_requests") return rqlOk([]);
        return rqlOk([]);
      },
      request: (method, path, body) => {
        expect(method).toBe("POST");
        expect(path).toBe("/collections/rr_requests/documents");
        const payload = JSON.parse(body ?? "{}") as { body: unknown };
        posts.push(payload.body);
        return reply(200, { ok: true, rid: 1 });
      },
    });

    await repo.ensureStore();

    expect(ddl).toContain("DROP COLLECTION IF EXISTS rr_requests");
    expect(ddl).toContain("CREATE DOCUMENT rr_requests");
    expect(posts).toEqual([requestDoc("c1", legacy)]);
  });

  it("loads requests from the canonical request document collection", async () => {
    const docReq = request("r1", { name: "Document wins" });
    const docReq2 = request("r2", { name: "Also document" });

    ipc({
      rql: (query) => {
        if (query === "LIST KV rr_collections")
          return rqlOk([
            kvRow("c1", {
              name: "API",
              order: ["r1", "r2"],
              vars: {},
              auth: { type: "none" },
            }),
          ]);
        if (query === "SELECT rid, body FROM rr_requests")
          return rqlOk([
            { rid: 7, body: requestDoc("c1", docReq) },
            { rid: 8, body: requestDoc("c1", docReq2) },
          ]);
        return rqlOk([]);
      },
    });

    const collections = await repo.loadAll();

    expect(collections).toHaveLength(1);
    expect(collections[0]!.requests.map((req) => req.name)).toEqual([
      "Document wins",
      "Also document",
    ]);
  });

  it("patches changed request fields instead of rewriting the whole request", async () => {
    vi.useFakeTimers();
    const current = request("r1", { name: "Old", headers: [] });
    const next = request("r1", {
      name: "New",
      headers: [{ name: "X-Test", value: "1", enabled: true }],
    });
    const operations: Array<Record<string, unknown>> = [];

    ipc({
      rql: (query) => {
        if (
          query ===
          "SELECT rid, body FROM rr_requests WHERE app_key = 'c1.r1' LIMIT 1"
        )
          return rqlOk([{ rid: 42, body: requestDoc("c1", current) }]);
        return rqlOk([]);
      },
      request: (method, path, body) => {
        expect(method).toBe("PATCH");
        expect(path).toBe("/collections/rr_requests/entities/42");
        operations.push(
          ...(
            JSON.parse(body ?? "{}") as {
              operations: Array<Record<string, unknown>>;
            }
          ).operations
        );
        return reply(200, { ok: true });
      },
    });

    await repo.saveRequest("c1", next);

    expect(operations).toEqual(
      expect.arrayContaining([
        { op: "set", path: "/body/request_name", value: "New" },
        { op: "set", path: "/body/request/name", value: "New" },
        {
          op: "set",
          path: "/body/request/headers",
          value: [{ name: "X-Test", value: "1", enabled: true }],
        },
      ])
    );
    expect(
      operations.some((op) =>
        String(op.path).startsWith("/body/request/headers/0")
      )
    ).toBe(false);
  });

  it("inserts a request document when no document exists for the app key", async () => {
    vi.useFakeTimers();
    const req = request("r1", { name: "Created" });
    const postedBodies: unknown[] = [];

    ipc({
      rql: (query) => {
        if (
          query ===
          "SELECT rid, body FROM rr_requests WHERE app_key = 'c1.r1' LIMIT 1"
        )
          return rqlOk([]);
        return rqlOk([]);
      },
      request: (method, path, body) => {
        expect(method).toBe("POST");
        expect(path).toBe("/collections/rr_requests/documents");
        postedBodies.push((JSON.parse(body ?? "{}") as { body: unknown }).body);
        return reply(200, { ok: true, rid: 99 });
      },
    });

    await repo.saveRequest("c1", req);

    expect(postedBodies).toEqual([requestDoc("c1", req)]);
  });

  it("reads request history from document commits and falls back to legacy KV commits", async () => {
    const docReq = request("r1", { name: "Document commit" });
    const legacyReq = request("r1", { name: "Legacy commit" });

    ipc({
      rql: (query) => {
        if (
          query ===
          `SELECT rid, body FROM rr_requests AS OF COMMIT '${"d".repeat(
            64
          )}' WHERE app_key = 'c1.r1' LIMIT 1`
        )
          return rqlOk([{ rid: 1, body: requestDoc("c1", docReq) }]);
        if (
          query ===
          `SELECT rid, body FROM rr_requests AS OF COMMIT '${"e".repeat(
            64
          )}' WHERE app_key = 'c1.r1' LIMIT 1`
        )
          return rqlOk([]);
        if (
          query ===
          `SELECT value FROM rr_requests AS OF COMMIT '${"e".repeat(
            64
          )}' WHERE key = 'c1.r1'`
        )
          return rqlOk([{ value: JSON.stringify(legacyReq) }]);
        return rqlOk([]);
      },
    });

    await expect(
      repo.requestAsOf("c1", "r1", "d".repeat(64))
    ).resolves.toMatchObject({ name: "Document commit" });
    await expect(
      repo.requestAsOf("c1", "r1", "e".repeat(64))
    ).resolves.toMatchObject({ name: "Legacy commit" });
  });
});
