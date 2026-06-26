import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { newRequest, type RequestDefinition } from "@red-request/core";
import * as repo from "./repo";

const REQ = "rr_requests";
const REQ_STAGE = "rr_requests_migration_stage";

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

function requestTarget(req: RequestDefinition): string {
  if (req.kind === "grpc") {
    const method = [req.grpc.service, req.grpc.method]
      .filter(Boolean)
      .join("/");
    return [req.url, method].filter(Boolean).join(" ");
  }
  if (req.url) return req.url;
  if (!req.net.host) return "";
  return req.net.port ? `${req.net.host}:${req.net.port}` : req.net.host;
}

function requestSearchText(colId: string, req: RequestDefinition): string {
  const target = requestTarget(req);
  return [
    colId,
    req.id,
    req.name,
    req.folder,
    req.kind,
    req.method,
    req.url,
    target,
    req.net.host,
    req.net.port ? String(req.net.port) : "",
    req.net.recordType,
    req.grpc.service,
    req.grpc.method,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function requestDoc(colId: string, req: RequestDefinition) {
  return {
    record_type: "request",
    app_key: `${colId}.${req.id}`,
    collection_id: colId,
    request_id: req.id,
    request_name: req.name,
    request_kind: req.kind,
    request_method: req.kind === "http" ? req.method : "",
    request_url: req.url,
    request_folder: req.folder,
    request_target: requestTarget(req),
    search_text: requestSearchText(colId, req),
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
  it("registers request search indexes through native RedDB migrations", async () => {
    const queries: string[] = [];

    ipc({
      rql: (query) => {
        queries.push(query);
        if (query === "SELECT name, status FROM red_migrations")
          return rqlOk([]);
        return rqlOk([{ message: "ok" }]);
      },
    });

    await repo.runMigrations();

    const create = queries.find((query) =>
      query.startsWith("CREATE MIGRATION request_document_search_indexes AS")
    );
    expect(create).toBeDefined();
    expect(create).not.toMatch(/^CREATE MIGRATION \d/);
    expect(create).toContain(
      "CREATE INDEX IF NOT EXISTS rr_requests_app_key ON rr_requests (app_key) USING HASH"
    );
    expect(create).toContain(
      "CREATE INDEX IF NOT EXISTS rr_requests_collection_id ON rr_requests (collection_id) USING HASH"
    );
    expect(create).toContain(
      "CREATE INDEX IF NOT EXISTS rr_requests_kind ON rr_requests (request_kind) USING BITMAP"
    );
    expect(create).toContain(
      "CREATE INDEX IF NOT EXISTS rr_requests_name ON rr_requests (request_name)"
    );
    expect(queries).toContain("APPLY MIGRATION *");
  });

  it("migrates legacy KV requests into the request document collection", async () => {
    const legacy = request("r1", { name: "GET users" });
    const ddl: string[] = [];
    const operations: string[] = [];
    const documents = new Map<string, unknown[]>();
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
          query ===
          "SELECT model FROM red.collections WHERE name = 'rr_requests_migration_stage' LIMIT 1"
        )
          return rqlOk([]);
        if (
          query.startsWith("CREATE KV ") ||
          query.startsWith("CREATE DOCUMENT ") ||
          query.startsWith("CREATE INDEX ") ||
          query.startsWith("ALTER TABLE ") ||
          query.startsWith("DROP COLLECTION ")
        ) {
          ddl.push(query);
          operations.push(query);
          if (query === "DROP COLLECTION IF EXISTS rr_requests") {
            expect(documents.get(REQ_STAGE)).toEqual([
              requestDoc("c1", legacy),
            ]);
            droppedRequests = true;
          }
          return rqlOk([{ message: "ok" }]);
        }
        if (query === "LIST KV rr_requests")
          return rqlOk([kvRow("c1.r1", legacy)]);
        if (query === "SELECT rid, body FROM rr_requests")
          return rqlOk(
            (documents.get(REQ) ?? []).map((body, i) => ({ rid: i + 1, body }))
          );
        if (query === "SELECT rid, body FROM rr_requests_migration_stage")
          return rqlOk(
            (documents.get(REQ_STAGE) ?? []).map((body, i) => ({
              rid: i + 1,
              body,
            }))
          );
        return rqlOk([]);
      },
      request: (method, path, body) => {
        expect(method).toBe("POST");
        const collection = decodeURIComponent(
          path.match(/^\/collections\/([^/]+)\/documents$/)?.[1] ?? ""
        );
        expect([REQ, REQ_STAGE]).toContain(collection);
        const payload = JSON.parse(body ?? "{}") as { body: unknown };
        operations.push(`POST ${collection}`);
        documents.set(collection, [
          ...(documents.get(collection) ?? []),
          payload.body,
        ]);
        return reply(200, { ok: true, rid: 1 });
      },
    });

    await repo.ensureStore();

    expect(ddl).toContain("DROP COLLECTION IF EXISTS rr_requests");
    expect(ddl).toContain("CREATE DOCUMENT rr_requests");
    expect(documents.get(REQ)).toEqual([requestDoc("c1", legacy)]);
    expect(operations.indexOf(`POST ${REQ_STAGE}`)).toBeLessThan(
      operations.indexOf("DROP COLLECTION IF EXISTS rr_requests")
    );
    expect(ddl).toContain(
      "DROP COLLECTION IF EXISTS rr_requests_migration_stage"
    );
  });

  it("keeps the legacy KV collection when staging the document migration fails", async () => {
    const legacy = request("r1", { name: "GET users" });
    const ddl: string[] = [];

    ipc({
      rql: (query) => {
        if (query.startsWith("SELECT name FROM red.collections"))
          return rqlOk([]);
        if (
          query ===
          "SELECT model FROM red.collections WHERE name = 'rr_requests' LIMIT 1"
        )
          return rqlOk([{ model: "kv" }]);
        if (
          query ===
          "SELECT model FROM red.collections WHERE name = 'rr_requests_migration_stage' LIMIT 1"
        )
          return rqlOk([]);
        if (
          query.startsWith("CREATE KV ") ||
          query.startsWith("CREATE DOCUMENT ") ||
          query.startsWith("CREATE INDEX ") ||
          query.startsWith("ALTER TABLE ") ||
          query.startsWith("DROP COLLECTION ")
        ) {
          ddl.push(query);
          return rqlOk([{ message: "ok" }]);
        }
        if (query === "LIST KV rr_requests")
          return rqlOk([kvRow("c1.r1", legacy)]);
        if (query === "SELECT rid, body FROM rr_requests_migration_stage")
          return rqlOk([]);
        return rqlOk([]);
      },
      request: () => reply(500, { ok: false, error: "disk full" }),
    });

    await expect(repo.ensureStore()).rejects.toThrow(/documentInsert/);
    expect(ddl).not.toContain("DROP COLLECTION IF EXISTS rr_requests");
  });

  it("recovers a staged request migration after restart", async () => {
    const staged = request("r1", { name: "Recovered" });
    const documents = new Map<string, unknown[]>([
      [REQ_STAGE, [requestDoc("c1", staged)]],
      [REQ, []],
    ]);
    const ddl: string[] = [];

    ipc({
      rql: (query) => {
        if (query.startsWith("SELECT name FROM red.collections"))
          return rqlOk([]);
        if (
          query ===
          "SELECT model FROM red.collections WHERE name = 'rr_requests' LIMIT 1"
        )
          return rqlOk([{ model: "document" }]);
        if (
          query ===
          "SELECT model FROM red.collections WHERE name = 'rr_requests_migration_stage' LIMIT 1"
        )
          return rqlOk([{ model: "document" }]);
        if (
          query.startsWith("CREATE KV ") ||
          query.startsWith("CREATE DOCUMENT ") ||
          query.startsWith("CREATE INDEX ") ||
          query.startsWith("ALTER TABLE ") ||
          query.startsWith("DROP COLLECTION ")
        ) {
          ddl.push(query);
          return rqlOk([{ message: "ok" }]);
        }
        if (query === "SELECT rid, body FROM rr_requests")
          return rqlOk(
            (documents.get(REQ) ?? []).map((body, i) => ({ rid: i + 1, body }))
          );
        if (query === "SELECT rid, body FROM rr_requests_migration_stage")
          return rqlOk(
            (documents.get(REQ_STAGE) ?? []).map((body, i) => ({
              rid: i + 1,
              body,
            }))
          );
        return rqlOk([]);
      },
      request: (method, path, body) => {
        expect(method).toBe("POST");
        expect(path).toBe("/collections/rr_requests/documents");
        documents.set(REQ, [
          ...(documents.get(REQ) ?? []),
          (JSON.parse(body ?? "{}") as { body: unknown }).body,
        ]);
        return reply(200, { ok: true, rid: 2 });
      },
    });

    await repo.ensureStore();

    expect(documents.get(REQ)).toEqual([requestDoc("c1", staged)]);
    expect(ddl).toContain(
      "DROP COLLECTION IF EXISTS rr_requests_migration_stage"
    );
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
        expect.objectContaining({
          op: "set",
          path: "/body/search_text",
          value: expect.stringContaining("new"),
        }),
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

  it("searches request documents through promoted search text", async () => {
    const req = request("r1", {
      name: "List users",
      method: "GET",
      url: "https://api.test/users",
    });

    ipc({
      rql: (query) => {
        if (
          query ===
          "SELECT rid, body FROM rr_requests WHERE search_text LIKE '%users%' LIMIT 10"
        )
          return rqlOk([{ rid: 7, body: requestDoc("c1", req) }]);
        return rqlOk([]);
      },
    });

    await expect(repo.searchRequests("users", 10)).resolves.toEqual([
      {
        rid: "7",
        collectionId: "c1",
        requestId: "r1",
        name: "List users",
        kind: "http",
        method: "GET",
        url: "https://api.test/users",
        folder: "",
        target: "https://api.test/users",
        request: req,
      },
    ]);
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
