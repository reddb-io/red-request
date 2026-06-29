import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import {
  newRequest,
  storedEnvironmentSchema,
  type RequestDefinition,
} from "@reddb-io/request-core";
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

function rqlErr(error: string) {
  return reply(200, {
    ok: false,
    error,
  });
}

function request(id: string, patch: Partial<RequestDefinition> = {}) {
  return { ...newRequest(id), ...patch };
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

function syncPayload(query: string): Record<string, unknown> {
  const prefix = "QUEUE PUSH rr_sync_events ";
  expect(query.startsWith(prefix)).toBe(true);
  return JSON.parse(query.slice(prefix.length)) as Record<string, unknown>;
}

afterEach(() => {
  repo.setProjectSyncQueueEnabled(false);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("project sync events", () => {
  it("does not create the durable fanout queue during local store boot", async () => {
    const queries: string[] = [];

    ipc({
      rql: (query) => {
        queries.push(query);
        if (
          query ===
          "SELECT model FROM red.collections WHERE name = 'rr_requests' LIMIT 1"
        )
          return rqlOk([{ model: "document" }]);
        return rqlOk([]);
      },
    });

    await repo.ensureStore();

    expect(queries).not.toContain(
      "CREATE QUEUE IF NOT EXISTS rr_sync_events FANOUT"
    );
  });

  it("creates the durable fanout queue during shared store boot", async () => {
    repo.setProjectSyncQueueEnabled(true);
    const queries: string[] = [];

    ipc({
      rql: (query) => {
        queries.push(query);
        if (
          query ===
          "SELECT model FROM red.collections WHERE name = 'rr_requests' LIMIT 1"
        )
          return rqlOk([{ model: "document" }]);
        return rqlOk([]);
      },
    });

    await repo.ensureStore();

    expect(queries).toContain(
      "CREATE QUEUE IF NOT EXISTS rr_sync_events FANOUT"
    );
  });

  it("reads and acknowledges project sync events through RedDB fanout queue delivery", async () => {
    const queries: string[] = [];

    ipc({
      rql: (query) => {
        queries.push(query);
        if (
          query ===
          "QUEUE READ rr_sync_events GROUP rr_client CONSUMER rr_client COUNT 20 WAIT 15000ms"
        )
          return rqlOk([
            {
              message_id: "123",
              delivery_id: "did-123",
              payload: {
                v: 1,
                id: "evt-1",
                ts: 1,
                source: "red-request",
                clientId: "client-2",
                kind: "request.saved",
                entity: { type: "request", id: "r1", parentId: "c1" },
                payload: {},
              },
              consumer: "rr_client",
              delivery_count: 1,
            },
          ]);
        return rqlOk([{ message: "ok" }]);
      },
    });

    const messages = await repo.readSyncEvents("rr_client", 15_000, 20);
    await repo.ackSyncEvent(
      messages[0]!.messageId,
      messages[0]!.deliveryId,
      messages[0]!.group
    );

    expect(messages).toEqual([
      expect.objectContaining({
        messageId: "123",
        deliveryId: "did-123",
        group: "rr_client",
        event: expect.objectContaining({
          kind: "request.saved",
          clientId: "client-2",
        }),
      }),
    ]);
    expect(queries).toContain("QUEUE GROUP CREATE rr_sync_events rr_client");
    expect(queries).toContain(
      "QUEUE READ rr_sync_events GROUP rr_client CONSUMER rr_client COUNT 20 WAIT 15000ms"
    );
    expect(queries).toContain(
      "QUEUE ACK rr_sync_events WITH delivery_id = 'did-123'"
    );
  });

  it("acknowledges project sync events by consumer group when delivery_id is absent", async () => {
    const queries: string[] = [];

    ipc({
      rql: (query) => {
        queries.push(query);
        if (
          query ===
          "QUEUE READ rr_sync_events GROUP rr_client CONSUMER rr_client COUNT 20 WAIT 15000ms"
        )
          return rqlOk([
            {
              message_id: "123",
              payload: {
                v: 1,
                id: "evt-1",
                ts: 1,
                source: "red-request",
                clientId: "client-2",
                kind: "request.saved",
                entity: { type: "request", id: "r1", parentId: "c1" },
                payload: {},
              },
              consumer: "rr_client",
              delivery_count: 1,
            },
          ]);
        return rqlOk([{ message: "ok" }]);
      },
    });

    const messages = await repo.readSyncEvents("rr_client", 15_000, 20);
    await repo.ackSyncEvent(
      messages[0]!.messageId,
      messages[0]!.deliveryId,
      messages[0]!.group
    );

    expect(queries).toContain("QUEUE GROUP CREATE rr_sync_events rr_client");
    expect(queries).toContain("QUEUE ACK rr_sync_events GROUP rr_client '123'");
  });

  it("does not emit queue events for local request saves by default", async () => {
    const queries: string[] = [];
    const req = request("r1", { name: "Create user" });

    ipc({
      rql: (query) => {
        queries.push(query);
        if (
          query ===
          "SELECT rid, body FROM rr_requests WHERE app_key = 'c1.r1' LIMIT 1"
        )
          return rqlOk([]);
        return rqlOk([]);
      },
      request: () => reply(200, { ok: true, rid: 7 }),
    });

    await repo.saveRequest("c1", req);

    expect(
      queries.filter((query) => query.startsWith("QUEUE PUSH rr_sync_events "))
    ).toHaveLength(0);
  });

  it("emits metadata-only request save events for shared projects", async () => {
    repo.setProjectSyncQueueEnabled(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T12:00:00Z"));
    const queries: string[] = [];
    const req = request("r1", {
      name: "Create user",
      method: "POST",
      url: "https://api.local/users?token=secret",
      body: { type: "json", content: '{"password":"secret"}', fields: [] },
    });

    ipc({
      rql: (query) => {
        queries.push(query);
        if (
          query ===
          "SELECT rid, body FROM rr_requests WHERE app_key = 'c1.r1' LIMIT 1"
        )
          return rqlOk([]);
        return rqlOk([]);
      },
      request: () => reply(200, { ok: true, rid: 7 }),
    });

    await repo.saveRequest("c1", req);

    const pushed = queries.filter((query) =>
      query.startsWith("QUEUE PUSH rr_sync_events ")
    );
    expect(pushed).toHaveLength(1);
    expect(syncPayload(pushed[0]!)).toMatchObject({
      v: 1,
      source: "red-request",
      clientId: expect.any(String),
      kind: "request.saved",
      entity: {
        type: "request",
        id: "r1",
        parentId: "c1",
        name: "Create user",
      },
      payload: {
        collectionId: "c1",
        requestId: "r1",
        requestName: "Create user",
        requestKind: "http",
        method: "POST",
        folder: "",
      },
    });
    expect(pushed[0]).not.toContain("password");
    expect(pushed[0]).not.toContain("token=secret");
    expect(queries.join("\n")).not.toContain("settings_sync_client_id");
  });

  it("does not fail shared request saves when sync event emission is unavailable", async () => {
    repo.setProjectSyncQueueEnabled(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queries: string[] = [];
    const requests: Array<{
      method: string;
      path: string;
      body: string | null;
    }> = [];

    ipc({
      rql: (query) => {
        queries.push(query);
        if (
          query ===
          "SELECT rid, body FROM rr_requests WHERE app_key = 'c1.r1' LIMIT 1"
        )
          return rqlOk([]);
        if (query.startsWith("QUEUE PUSH rr_sync_events "))
          return rqlErr("queue unavailable");
        return rqlOk([]);
      },
      request: (method, path, body) => {
        requests.push({ method, path, body });
        return reply(200, { ok: true, rid: 7 });
      },
    });

    await expect(
      repo.saveRequest("c1", request("r1"))
    ).resolves.toBeUndefined();

    expect(requests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/collections/rr_requests/documents",
      }),
    ]);
    expect(queries.some((query) => query.startsWith("QUEUE PUSH "))).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[ui] sync event request.saved not emitted")
    );
    warn.mockRestore();
  });

  it("uses a runtime client id instead of a project-shared config id", async () => {
    const queries: string[] = [];

    ipc({
      rql: (query) => {
        queries.push(query);
        return rqlOk([]);
      },
    });

    const id = await repo.currentSyncClientId();
    const consumer = await repo.syncConsumerName();

    expect(id).toEqual(expect.any(String));
    expect(id.length).toBeGreaterThan(0);
    expect(consumer).toMatch(/^rr_[0-9a-f]+$/);
    expect(queries).toEqual([]);
  });

  it("keeps one runtime id for all shared events without writing it into the project", async () => {
    repo.setProjectSyncQueueEnabled(true);
    const queries: string[] = [];

    ipc({
      rql: (query) => {
        queries.push(query);
        if (
          query ===
          "SELECT rid, body FROM rr_requests WHERE app_key = 'c1.r1' LIMIT 1"
        )
          return rqlOk([]);
        if (
          query ===
          "SELECT rid, body FROM rr_requests WHERE app_key = 'c1.r2' LIMIT 1"
        )
          return rqlOk([]);
        return rqlOk([]);
      },
      request: () => reply(200, { ok: true, rid: 7 }),
    });

    await repo.saveRequest("c1", request("r1"));
    await repo.saveRequest("c1", request("r2"));

    const pushed = queries.filter((query) =>
      query.startsWith("QUEUE PUSH rr_sync_events ")
    );
    expect(pushed).toHaveLength(2);
    const first = syncPayload(pushed[0]!);
    const second = syncPayload(pushed[1]!);
    expect(first.clientId).toEqual(expect.any(String));
    expect(second.clientId).toBe(first.clientId);
    expect(queries.join("\n")).not.toContain("settings_sync_client_id");
  });

  it("does not leak secret values into queue events", async () => {
    repo.setProjectSyncQueueEnabled(true);
    const queries: string[] = [];
    const env = storedEnvironmentSchema.parse({
      name: "dev",
      vars: {},
      secrets: {},
    });

    ipc({
      rql: (query) => {
        queries.push(query);
        return rqlOk([{ message: "ok" }]);
      },
    });

    await repo.saveEnvironmentSecret(env, "API_KEY", "sk_live");

    const pushed = queries.filter((query) =>
      query.startsWith("QUEUE PUSH rr_sync_events ")
    );
    expect(pushed).toHaveLength(1);
    expect(syncPayload(pushed[0]!)).toMatchObject({
      kind: "secret.saved",
      entity: {
        type: "secret",
        id: "dev:API_KEY",
        parentId: "dev",
        name: "API_KEY",
      },
      payload: {
        environment: "dev",
        secretName: "API_KEY",
      },
    });
    expect(pushed[0]).not.toContain("sk_live");
  });

  it("emits collection delete events after deleting owned rows", async () => {
    repo.setProjectSyncQueueEnabled(true);
    const queries: string[] = [];

    ipc({
      rql: (query) => {
        queries.push(query);
        if (query === "SELECT rid, body FROM rr_requests")
          return rqlOk([
            {
              rid: 3,
              body: {
                record_type: "request",
                app_key: "c1.r1",
                collection_id: "c1",
                request_id: "r1",
                request: request("r1"),
              },
            },
          ]);
        if (query === "LIST KV rr_history")
          return rqlOk([
            {
              key: "h1",
              value: JSON.stringify({ collectionId: "c1" }),
            },
          ]);
        return rqlOk([]);
      },
      request: () => reply(200, { ok: true }),
    });

    await repo.deleteCollection("c1");

    expect(queries).toContain("KV DELETE rr_collections.'c1'");
    const pushed = queries.filter((query) =>
      query.startsWith("QUEUE PUSH rr_sync_events ")
    );
    expect(syncPayload(pushed[0]!)).toMatchObject({
      kind: "collection.deleted",
      entity: { type: "collection", id: "c1" },
      payload: { collectionId: "c1" },
    });
  });
});
