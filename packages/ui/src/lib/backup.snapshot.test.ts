import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { snapshot } from "./backup";

const reply = (status: number, body: unknown) => ({
  status,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

function rqlOk(records: Array<Record<string, unknown>> = []) {
  return reply(200, {
    ok: true,
    data: { columns: Object.keys(records[0] ?? {}), records },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("backup snapshot", () => {
  it("reads rr_history as a document collection, never via LIST KV", async () => {
    const queries: string[] = [];
    mockIPC((cmd, args) => {
      const a = args as Record<string, unknown>;
      if (cmd === "reddb_rql") {
        queries.push(a.query as string);
        return rqlOk([]);
      }
      return null;
    });

    await snapshot();

    // The regression: LIST KV on rr_history (a document collection) errored on every
    // launch's auto-backup. It must never be issued.
    expect(queries).not.toContain("LIST KV rr_history");
    // rr_history is instead read the document way.
    expect(queries.some((q) => /from\s+rr_history/i.test(q))).toBe(true);
    // The genuinely-KV app collections are still snapshotted via LIST KV.
    expect(queries).toContain("LIST KV rr_collections");
  });
});
