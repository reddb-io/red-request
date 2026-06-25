import { describe, it, expect, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import * as db from "./reddb";

// HttpReply shape the Rust commands return.
const reply = (status: number, body: unknown) => ({
  status,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/** Route reddb_rql + reddb_request to a handler; unhandled commands return null. */
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

describe("commit", () => {
  it("posts to /repo/commits with a nested author object and returns the hash", async () => {
    let seen: { path: string; body: unknown } | null = null;
    ipc({
      request: (method, path, body) => {
        seen = { path, body: JSON.parse(body ?? "{}") };
        expect(method).toBe("POST");
        return reply(200, { ok: true, result: { hash: "a".repeat(64) } });
      },
    });

    const hash = await db.commit("save request Foo");

    expect(hash).toBe("a".repeat(64));
    expect(seen!.path).toBe("/repo/commits");
    const sent = seen!.body as Record<string, unknown>;
    expect(sent.connection_id).toBe(0);
    expect(sent.message).toBe("save request Foo");
    // reddb's parse_author reads author.name / author.email — must be an object.
    expect(sent.author).toMatchObject({
      name: expect.any(String),
      email: expect.any(String),
    });
  });

  it("returns null when the server declines (non-2xx)", async () => {
    ipc({
      request: () => reply(409, { ok: false, error: "nothing to commit" }),
    });
    expect(await db.commit("noop")).toBeNull();
  });

  it("returns null on a transport error", async () => {
    mockIPC(() => {
      throw new Error("sidecar down");
    });
    expect(await db.commit("x")).toBeNull();
  });
});

describe("listCommits", () => {
  it("parses the {ok,result:[...]} shape with author objects and timestamp_ms", async () => {
    ipc({
      request: (_m, path) => {
        expect(path).toContain("/repo/commits");
        return reply(200, {
          ok: true,
          result: [
            {
              hash: "h1",
              message: "save request Foo",
              author: { name: "red-request", email: "app@red-request.local" },
              timestamp_ms: 1700000000000,
            },
            {
              hash: "h2",
              message: "delete request",
              author: { name: "red-request" },
              timestamp_ms: 1700000001000,
            },
          ],
        });
      },
    });

    const commits = await db.listCommits(10);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      hash: "h1",
      message: "save request Foo",
      author: "red-request",
      timestampMs: 1700000000000,
    });
    expect(commits[1]!.hash).toBe("h2");
  });

  it("returns [] on failure", async () => {
    ipc({ request: () => reply(500, "boom") });
    expect(await db.listCommits()).toEqual([]);
  });
});

describe("kvGetAsOf", () => {
  it("reads a JSON value via SELECT ... AS OF COMMIT and parses it", async () => {
    let sql = "";
    ipc({
      rql: (q) => {
        sql = q;
        return reply(200, {
          ok: true,
          data: {
            columns: ["value"],
            records: [{ value: JSON.stringify({ name: "v1" }) }],
          },
        });
      },
    });

    const val = await db.kvGetAsOf<{ name: string }>(
      "rr_requests",
      "c1.r1",
      "b".repeat(64)
    );
    expect(val).toEqual({ name: "v1" });
    expect(sql).toContain("AS OF COMMIT");
    expect(sql).toContain("b".repeat(64)); // full hash, not truncated
    expect(sql).toContain("rr_requests");
  });

  it("returns null when no version is visible at that commit", async () => {
    ipc({
      rql: () =>
        reply(200, { ok: true, data: { columns: ["value"], records: [] } }),
    });
    expect(
      await db.kvGetAsOf("rr_requests", "c1.r1", "c".repeat(64))
    ).toBeNull();
  });
});

describe("setVersioned", () => {
  it("issues ALTER TABLE ... SET VERSIONED and tolerates errors", async () => {
    let sql = "";
    ipc({
      rql: (q) => {
        sql = q;
        return reply(200, {
          ok: true,
          data: { columns: ["message"], records: [{ message: "ok" }] },
        });
      },
    });
    await expect(db.setVersioned("rr_requests")).resolves.toBeUndefined();
    expect(sql).toBe("ALTER TABLE rr_requests SET VERSIONED = true");
  });
});

describe("commitSoon", () => {
  it("debounces a burst of edits into a single commit", async () => {
    vi.useFakeTimers();
    let commits = 0;
    ipc({
      request: () => {
        commits++;
        return reply(200, { ok: true, result: { hash: "d".repeat(64) } });
      },
    });

    db.commitSoon("edit", 1500);
    db.commitSoon("edit", 1500);
    db.commitSoon("edit", 1500);
    expect(commits).toBe(0); // nothing fired yet

    await vi.advanceTimersByTimeAsync(1500);
    expect(commits).toBe(1); // one coalesced commit

    vi.useRealTimers();
  });
});
