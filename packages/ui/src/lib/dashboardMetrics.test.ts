import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "@reddb-io/request-core";
import { networkIdentityRows } from "./dashboardMetrics";

const base = {
  reqId: "req-1",
  collectionId: "col-1",
  name: "List users",
  method: "GET",
  url: "https://api.example.test/users",
  size: 0,
  testsPassed: 0,
  testsFailed: 0,
} satisfies Partial<HistoryEntry>;

describe("networkIdentityRows", () => {
  it("groups runs by profile, proxy and dispatcher with latency and error rates", () => {
    const rows = networkIdentityRows([
      {
        ...base,
        id: "run-2",
        ts: 200,
        status: 502,
        ok: false,
        durationMs: 250,
        profileId: "pf-team",
        profileName: "Team identity",
        proxyId: "px-team",
        proxyName: "Team proxy",
        proxyUrl: "socks5h://proxy.internal:1080",
        dispatcherClientId: "client-1",
      },
      {
        ...base,
        id: "run-1",
        ts: 100,
        status: 200,
        ok: true,
        durationMs: 100,
        profileId: "pf-team",
        profileName: "Team identity",
        proxyId: "px-team",
        proxyName: "Team proxy",
        proxyUrl: "socks5h://proxy.internal:1080",
        dispatcherClientId: "client-1",
      },
    ] as HistoryEntry[]);

    expect(rows).toEqual([
      {
        key: "pf-team|px-team|client-1",
        profile: "Team identity",
        proxy: "Team proxy",
        proxyUrl: "socks5h://proxy.internal:1080",
        dispatcher: "client-1",
        runs: 2,
        errors: 1,
        errorRate: 50,
        okRate: 50,
        avgMs: 175,
        lastTs: 200,
      },
    ]);
  });
});
