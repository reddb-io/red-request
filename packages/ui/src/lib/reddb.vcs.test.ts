import { describe, it, expect, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import * as db from "./reddb";

// HttpReply shape the Rust commands return.
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

type SimMigrationStatus = "pending" | "applied" | "failed";

function migrationStore(
  initial: Record<
    string,
    { status: SimMigrationStatus; dependsOn?: string[] }
  > = {}
) {
  const migrations = new Map<
    string,
    { status: SimMigrationStatus; dependsOn: string[] }
  >(
    Object.entries(initial).map(([name, m]) => [
      name,
      { status: m.status, dependsOn: m.dependsOn ?? [] },
    ])
  );
  const queries: string[] = [];

  function applyPending() {
    let applied = 0;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [name, m] of migrations) {
        if (m.status !== "pending") continue;
        const ready = m.dependsOn.every(
          (dep) => migrations.get(dep)?.status === "applied"
        );
        if (!ready) continue;
        m.status = "applied";
        applied++;
        progressed = true;
        migrations.set(name, m);
      }
    }
    const blocked = [...migrations].find(
      ([, m]) => m.status === "pending" && m.dependsOn.length > 0
    );
    if (blocked)
      return reply(200, {
        ok: false,
        error: `dependency not applied for ${blocked[0]}`,
      });
    return rqlOk([{ message: `applied ${applied} migration(s)` }]);
  }

  return {
    queries,
    status(name: string) {
      return migrations.get(name)?.status ?? null;
    },
    rql(query: string) {
      queries.push(query);
      if (query === "SELECT name, status FROM red_migrations")
        return rqlOk(
          [...migrations].map(([name, m]) => ({
            name,
            status: m.status,
          }))
        );

      const create = query.match(
        /^CREATE MIGRATION ([A-Za-z_][A-Za-z0-9_]*)(?: DEPENDS ON ([A-Za-z_][A-Za-z0-9_]*(?:, [A-Za-z_][A-Za-z0-9_]*)*))? AS /
      );
      if (create) {
        const name = create[1]!;
        if (migrations.has(name))
          return reply(200, {
            ok: false,
            error: `migration '${name}' already exists`,
          });
        migrations.set(name, {
          status: "pending",
          dependsOn: create[2]?.split(", ") ?? [],
        });
        return rqlOk([{ message: `migration '${name}' registered` }]);
      }

      if (query === "APPLY MIGRATION *") return applyPending();

      return rqlOk([{ message: "ok" }]);
    },
  };
}

describe("runMigrations", () => {
  it("simulates first app boot on a brand-new store", async () => {
    const store = migrationStore();
    ipc({ rql: store.rql });

    await db.runMigrations([
      { name: "request_base", sql: "CREATE TABLE request_base (id BIGINT)" },
      {
        name: "request_tags",
        dependsOn: ["request_base"],
        sql: "ALTER TABLE request_base ADD COLUMN tags TEXT",
      },
    ]);

    expect(store.queries).toEqual([
      "SELECT name, status FROM red_migrations",
      "CREATE MIGRATION request_base AS CREATE TABLE request_base (id BIGINT)",
      "CREATE MIGRATION request_tags DEPENDS ON request_base AS ALTER TABLE request_base ADD COLUMN tags TEXT",
      "APPLY MIGRATION *",
    ]);
    expect(store.status("request_base")).toBe("applied");
    expect(store.status("request_tags")).toBe("applied");
  });

  it("simulates a second app boot on the same already-migrated store", async () => {
    const store = migrationStore();
    ipc({ rql: store.rql });
    const defs = [
      { name: "request_base", sql: "CREATE TABLE request_base (id BIGINT)" },
      {
        name: "request_tags",
        dependsOn: ["request_base"],
        sql: "ALTER TABLE request_base ADD COLUMN tags TEXT",
      },
    ];

    await db.runMigrations(defs);
    store.queries.length = 0;
    await db.runMigrations(defs);

    expect(store.queries).toEqual([
      "SELECT name, status FROM red_migrations",
      "APPLY MIGRATION *",
    ]);
    expect(store.status("request_base")).toBe("applied");
    expect(store.status("request_tags")).toBe("applied");
  });

  it("simulates opening an existing store where shipped migrations are already applied", async () => {
    const store = migrationStore({
      request_document_search_indexes: { status: "applied" },
    });
    ipc({ rql: store.rql });

    await db.runMigrations([
      {
        name: "request_document_search_indexes",
        sql: "CREATE INDEX IF NOT EXISTS rr_requests_app_key ON rr_requests (app_key) USING HASH",
      },
    ]);

    expect(store.queries).toEqual([
      "SELECT name, status FROM red_migrations",
      "APPLY MIGRATION *",
    ]);
    expect(store.status("request_document_search_indexes")).toBe("applied");
  });

  it("simulates opening an existing store after registration succeeded but apply was interrupted", async () => {
    const store = migrationStore({
      request_document_search_indexes: { status: "pending" },
    });
    ipc({ rql: store.rql });

    await db.runMigrations([
      {
        name: "request_document_search_indexes",
        sql: "CREATE INDEX IF NOT EXISTS rr_requests_app_key ON rr_requests (app_key) USING HASH",
      },
    ]);

    expect(store.queries).toEqual([
      "SELECT name, status FROM red_migrations",
      "APPLY MIGRATION *",
    ]);
    expect(store.status("request_document_search_indexes")).toBe("applied");
  });

  it("simulates opening an existing store with a failed shipped migration", async () => {
    const store = migrationStore({
      request_document_search_indexes: { status: "failed" },
    });
    ipc({ rql: store.rql });

    await expect(
      db.runMigrations([
        {
          name: "request_document_search_indexes",
          sql: "CREATE INDEX IF NOT EXISTS rr_requests_app_key ON rr_requests (app_key) USING HASH",
        },
      ])
    ).rejects.toThrow(
      /RedDB migration request_document_search_indexes is failed/
    );

    expect(store.queries).toEqual(["SELECT name, status FROM red_migrations"]);
    expect(store.status("request_document_search_indexes")).toBe("failed");
  });

  it("simulates an app upgrade on an existing store by registering only the newly shipped migration", async () => {
    const store = migrationStore({
      request_base: { status: "applied" },
    });
    ipc({ rql: store.rql });

    await db.runMigrations([
      { name: "request_base", sql: "CREATE TABLE request_base (id BIGINT)" },
      {
        name: "request_tags",
        dependsOn: ["request_base"],
        sql: "ALTER TABLE request_base ADD COLUMN tags TEXT",
      },
    ]);

    expect(store.queries).toEqual([
      "SELECT name, status FROM red_migrations",
      "CREATE MIGRATION request_tags DEPENDS ON request_base AS ALTER TABLE request_base ADD COLUMN tags TEXT",
      "APPLY MIGRATION *",
    ]);
    expect(store.status("request_base")).toBe("applied");
    expect(store.status("request_tags")).toBe("applied");
  });

  it("rejects migration names that RedDB cannot parse before issuing RQL", async () => {
    const queries: string[] = [];
    ipc({
      rql: (query) => {
        queries.push(query);
        return rqlOk([]);
      },
    });

    await expect(
      db.runMigrations([{ name: "0001_bad", sql: "SELECT 1" }])
    ).rejects.toThrow(/invalid RedDB migration name "0001_bad"/);
    expect(queries).toEqual([]);
  });

  it("rejects invalid migration dependencies before issuing RQL", async () => {
    const queries: string[] = [];
    ipc({
      rql: (query) => {
        queries.push(query);
        return rqlOk([]);
      },
    });

    await expect(
      db.runMigrations([
        {
          name: "request_tags",
          dependsOn: ["0001_request_document_search_indexes"],
          sql: "SELECT 1",
        },
      ])
    ).rejects.toThrow(
      /invalid RedDB migration dependency "0001_request_document_search_indexes"/
    );
    expect(queries).toEqual([]);
  });

  it("registers valid dependencies explicitly", async () => {
    const queries: string[] = [];
    ipc({
      rql: (query) => {
        queries.push(query);
        if (query === "SELECT name, status FROM red_migrations")
          return rqlOk([]);
        return rqlOk([{ message: "ok" }]);
      },
    });

    await db.runMigrations([
      { name: "request_base", sql: "CREATE TABLE request_base (id BIGINT)" },
      {
        name: "request_tags",
        dependsOn: ["request_base"],
        sql: "ALTER TABLE request_base ADD COLUMN tags TEXT",
      },
    ]);

    expect(queries).toContain(
      "CREATE MIGRATION request_tags DEPENDS ON request_base AS ALTER TABLE request_base ADD COLUMN tags TEXT"
    );
    expect(queries).toContain("APPLY MIGRATION *");
  });

  it.each([
    [
      "duplicate names",
      [
        { name: "duplicate_request_tags", sql: "SELECT 1" },
        { name: "duplicate_request_tags", sql: "SELECT 2" },
      ],
      /duplicate RedDB migration name "duplicate_request_tags"/,
    ],
    [
      "empty SQL",
      [{ name: "empty_request_tags", sql: "   " }],
      /invalid RedDB migration "empty_request_tags": SQL is empty/,
    ],
    [
      "full CREATE MIGRATION statement",
      [
        {
          name: "wrapped_request_tags",
          sql: "CREATE MIGRATION nested AS SELECT 1",
        },
      ],
      /sql must be the body after AS/,
    ],
    [
      "BATCH clause",
      [{ name: "batched_request_tags", sql: "BATCH 100 ROWS AS UPDATE users" }],
      /BATCH is not supported by this app wrapper/,
    ],
    [
      "self dependency",
      [
        {
          name: "self_dependent_request_tags",
          dependsOn: ["self_dependent_request_tags"],
          sql: "SELECT 1",
        },
      ],
      /depends on itself/,
    ],
    [
      "unknown dependency",
      [
        {
          name: "orphan_request_tags",
          dependsOn: ["missing_request_base"],
          sql: "SELECT 1",
        },
      ],
      /unknown dependency "missing_request_base"/,
    ],
    [
      "NUL byte",
      [{ name: "nul_request_tags", sql: "SELECT '\0'" }],
      /SQL contains NUL/,
    ],
  ] satisfies Array<[string, Parameters<typeof db.runMigrations>[0], RegExp]>)(
    "rejects %s before issuing RQL",
    async (_name, defs, expected) => {
      const queries: string[] = [];
      ipc({
        rql: (query) => {
          queries.push(query);
          return rqlOk([]);
        },
      });

      await expect(db.runMigrations(defs)).rejects.toThrow(expected);
      expect(queries).toEqual([]);
    }
  );

  it("fails closed when the migration catalog cannot be inspected", async () => {
    ipc({
      rql: (query) => {
        if (query === "SELECT name, status FROM red_migrations")
          return reply(200, { ok: false, error: "red_migrations unavailable" });
        return rqlOk([]);
      },
    });

    await expect(
      db.runMigrations([{ name: "request_tags", sql: "SELECT 1" }])
    ).rejects.toThrow(/failed to inspect RedDB migrations/);
  });
});

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
  it("can flush a pending debounced commit immediately", async () => {
    vi.useFakeTimers();
    let commits = 0;
    ipc({
      request: () => {
        commits++;
        return reply(200, { ok: true, result: { hash: "e".repeat(64) } });
      },
    });

    db.commitSoon("edit", 1500);

    await expect(db.flushPendingCommit()).resolves.toBe("e".repeat(64));
    expect(commits).toBe(1);

    await vi.advanceTimersByTimeAsync(1500);
    expect(commits).toBe(1);

    vi.useRealTimers();
  });

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

  it("waits for an in-flight debounced commit when flushed", async () => {
    vi.useFakeTimers();
    let resolveCommit!: () => void;
    let commits = 0;
    ipc({
      request: async () => {
        commits++;
        await new Promise<void>((resolve) => {
          resolveCommit = resolve;
        });
        return reply(200, { ok: true, result: { hash: "f".repeat(64) } });
      },
    });

    db.commitSoon("edit", 1500);
    await vi.advanceTimersByTimeAsync(1500);
    expect(commits).toBe(1);

    let flushed = false;
    const flushing = db.flushPendingCommit().then((hash) => {
      flushed = true;
      return hash;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(flushed).toBe(false);

    resolveCommit();
    await expect(flushing).resolves.toBe("f".repeat(64));
    expect(flushed).toBe(true);

    vi.useRealTimers();
  });
});

describe("project VCS time travel", () => {
  it("loads a commit diff summary", async () => {
    let seen: { method: string; path: string; body: string | null } | null =
      null;
    ipc({
      request: (method, path, body) => {
        seen = { method, path, body };
        return reply(200, {
          ok: true,
          result: {
            from: "a".repeat(64),
            to: "b".repeat(64),
            added: 1,
            removed: 0,
            modified: 2,
            entries: [
              {
                collection: "rr_requests",
                entity_id: "col.req",
                change: "modified",
              },
            ],
          },
        });
      },
    });

    await expect(
      db.commitDiffSummary("a".repeat(64), "b".repeat(64))
    ).resolves.toMatchObject({
      added: 1,
      removed: 0,
      modified: 2,
      entries: [
        {
          collection: "rr_requests",
          entityId: "col.req",
          change: "modified",
        },
      ],
    });
    expect(seen).toEqual({
      method: "GET",
      path: `/repo/commits/${"a".repeat(64)}/diff/${"b".repeat(64)}?summary=true`,
      body: null,
    });
  });

  it("restores the project by hard-resetting session 0 to a commit", async () => {
    let seen: { method: string; path: string; body: string | null } | null =
      null;
    ipc({
      request: (method, path, body) => {
        seen = { method, path, body };
        return reply(200, { ok: true, result: {} });
      },
    });

    await expect(
      db.resetProjectToCommit("f".repeat(64))
    ).resolves.toBeUndefined();
    expect(seen).toEqual({
      method: "POST",
      path: "/repo/sessions/0/reset",
      body: JSON.stringify({ target: "f".repeat(64), mode: "hard" }),
    });
  });
});
