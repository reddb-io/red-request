import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/svelte";
import { newRequest } from "@reddb-io/request-core";
import { ws } from "../store.svelte";
import RequestPanel from "./RequestPanel.svelte";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
}));

describe("RequestPanel network identity controls", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    ws.collections = [];
    ws.activeColId = null;
    ws.activeReq = null;
    ws.network = { proxies: [], profiles: [] };
    ws.wsStatus = "idle";
    ws.wsMessages = [];
  });

  afterEach(() => {
    cleanup();
  });

  it("shows a profile-locked proxy route for websocket requests", async () => {
    const req = {
      ...newRequest("req-ws"),
      kind: "ws" as const,
      name: "Live feed",
      url: "wss://api.example.test/feed",
      profileId: "prof-1",
      proxy: "http://request.proxy:8080",
    };
    ws.collections = [
      {
        id: "col-1",
        collection: {
          name: "Realtime API",
          order: ["req-ws"],
          folders: [],
          vars: {},
          auth: { type: "none" },
          cookieJar: false,
          defaultProfileId: "",
        },
        requests: [req],
        environments: [],
      },
    ];
    ws.activeColId = "col-1";
    ws.activeReq = req;
    ws.network = {
      proxies: [
        {
          id: "px-team",
          name: "Team proxy",
          type: "socks5h",
          host: "proxy.internal",
          port: "1080",
          username: "",
          password: "",
        },
      ],
      profiles: [
        {
          id: "prof-1",
          name: "Team identity",
          userAgent: "",
          headers: [],
          proxyId: "px-team",
        },
      ],
    };

    render(RequestPanel);

    expect(await screen.findByLabelText("User profile")).toBeTruthy();
    expect(screen.getByText("Profile proxy")).toBeTruthy();
    expect(screen.getByText("Team proxy")).toBeTruthy();
    expect(screen.queryByLabelText("Request proxy route")).toBeNull();
  });
});
