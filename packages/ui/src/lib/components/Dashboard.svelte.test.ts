import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/svelte";
import { newRequest } from "@reddb-io/request-core";

vi.mock("../repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repo")>()),
  loadHistory: vi.fn(async () => []),
}));

import * as repo from "../repo";
import { ws } from "../store.svelte";
import Dashboard from "./Dashboard.svelte";

describe("Dashboard network identity metrics", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    ws.collections = [
      {
        id: "col-1",
        collection: {
          name: "Team API",
          order: ["req-1"],
          folders: [],
          vars: {},
          auth: { type: "none" },
          cookieJar: false,
          defaultProfileId: "",
        },
        requests: [
          {
            ...newRequest("req-1"),
            name: "List users",
            method: "GET",
            url: "https://api.example.test/users",
          },
        ],
        environments: [],
      },
    ];
    ws.activeColId = "col-1";
  });

  afterEach(() => {
    cleanup();
  });

  it("summarizes latency and errors by profile, proxy and dispatcher", async () => {
    vi.mocked(repo.loadHistory).mockResolvedValueOnce([
      {
        id: "run-2",
        reqId: "req-1",
        collectionId: "col-1",
        name: "List users",
        method: "GET",
        url: "https://api.example.test/users",
        ts: 200,
        status: 502,
        ok: false,
        durationMs: 250,
        size: 0,
        testsPassed: 0,
        testsFailed: 0,
        profileId: "pf-team",
        profileName: "Team identity",
        proxyId: "px-team",
        proxyName: "Team proxy",
        proxyUrl: "socks5h://proxy.internal:1080",
        dispatcherClientId: "client-1",
        dispatcherHost: "ci-runner-7",
        dispatcherUser: "alice",
      },
      {
        id: "run-1",
        reqId: "req-1",
        collectionId: "col-1",
        name: "List users",
        method: "GET",
        url: "https://api.example.test/users",
        ts: 100,
        status: 200,
        ok: true,
        durationMs: 100,
        size: 0,
        testsPassed: 0,
        testsFailed: 0,
        profileId: "pf-team",
        profileName: "Team identity",
        proxyId: "px-team",
        proxyName: "Team proxy",
        proxyUrl: "socks5h://proxy.internal:1080",
        dispatcherClientId: "client-1",
        dispatcherHost: "ci-runner-7",
        dispatcherUser: "alice",
      },
    ]);

    render(Dashboard);

    expect(
      await screen.findByText("Network identity performance")
    ).toBeTruthy();
    expect(screen.getByText("Team identity")).toBeTruthy();
    expect(screen.getByText("Team proxy")).toBeTruthy();
    expect(screen.getByText("alice@ci-runner-7")).toBeTruthy();
    expect(screen.getByText("client-1")).toBeTruthy();
    expect(screen.getByText("2 runs")).toBeTruthy();
    expect(screen.getByText("50% errors")).toBeTruthy();
    expect(screen.getAllByText("175ms").length).toBeGreaterThan(0);
  });
});
