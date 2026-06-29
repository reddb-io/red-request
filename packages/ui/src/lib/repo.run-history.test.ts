import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { HistoryEntry } from "@reddb-io/request-core";
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

function run(id: string, patch: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    reqId: "r1",
    collectionId: "c1",
    name: "GET users",
    method: "GET",
    url: "https://example.test/users",
    ts: 1,
    status: 200,
    ok: true,
    durationMs: 42,
    size: 12,
    testsPassed: 0,
    testsFailed: 0,
    ...patch,
  };
}

function historyDoc(entry: HistoryEntry) {
  return {
    record_type: "run_history",
    app_key: entry.id,
    collection_id: entry.collectionId,
    request_id: entry.reqId,
    run_ts: entry.ts,
    request_name: entry.name,
    request_method: entry.method,
    request_url: entry.url,
    run_status: entry.status,
    run_ok: entry.ok,
    duration_ms: entry.durationMs,
    entry,
  };
}

function ipc(handlers: {
  rql?: (query: string) => unknown;
  request?: (method: string, path: string, body: string | null) => unknown;
}) {
  mockIPC((cmd, args) => {
    const a = args as Record<string, unknown>;
    if (cmd === "reddb_rql")
      return handlers.rql?.(a.query as string) ?? rqlOk([]);
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

describe("document-backed run history", () => {
  it("loads execution history with document filters instead of LIST KV rr_history", async () => {
    const queries: string[] = [];
    const entry = run("run-1");

    ipc({
      rql: (query) => {
        queries.push(query);
        if (
          query ===
          "SELECT rid, body FROM rr_history WHERE collection_id = 'c1' AND request_id = 'r1' ORDER BY run_ts DESC"
        )
          return rqlOk([{ rid: 1, body: historyDoc(entry) }]);
        return rqlOk([]);
      },
    });

    await expect(repo.loadHistory("c1", "r1")).resolves.toEqual([entry]);
    expect(queries).toEqual([
      "SELECT rid, body FROM rr_history WHERE collection_id = 'c1' AND request_id = 'r1' ORDER BY run_ts DESC",
    ]);
    expect(queries).not.toContain("LIST KV rr_history");
  });

  it("saves run history as documents and prunes only the current request", async () => {
    const queries: string[] = [];
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const current = run("run-new", { ts: 100 });
    const rows = Array.from({ length: 51 }, (_, i) => {
      const entry =
        i === 50 ? run("oldest", { ts: i }) : run(`run-${i}`, { ts: i });
      return { rid: String(i + 1), body: historyDoc(entry) };
    });

    ipc({
      rql: (query) => {
        queries.push(query);
        if (
          query ===
          "SELECT rid, body FROM rr_history WHERE collection_id = 'c1' AND request_id = 'r1' ORDER BY run_ts DESC"
        )
          return rqlOk(rows);
        return rqlOk([]);
      },
      request: (method, path, body) => {
        requests.push({ method, path, body: body ? JSON.parse(body) : null });
        return reply(200, {
          ok: true,
          rid: "new-rid",
          body: historyDoc(current),
        });
      },
    });

    await repo.saveHistory(current);

    expect(requests[0]).toEqual({
      method: "POST",
      path: "/collections/rr_history/documents",
      body: { body: historyDoc(current) },
    });
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/collections/rr_history/entities/51",
    });
    expect(queries).not.toContain("LIST KV rr_history");
  });
});
