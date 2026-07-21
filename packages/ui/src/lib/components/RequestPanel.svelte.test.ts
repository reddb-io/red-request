import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { collectionFileSchema, newRequest } from "@reddb-io/request-core";
import { ws } from "../store.svelte";
import RequestPanel from "./RequestPanel.svelte";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
}));

vi.mock("../repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repo")>()),
  saveRequest: vi.fn(async () => {}),
}));

import * as repo from "../repo";

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
          rootOrder: [],
          vars: {},
          auth: { type: "none" },
          cookieJar: false,
          defaultProfileId: "",
          defaultHeaders: [],
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
          cookieJar: false,
        },
      ],
    };

    render(RequestPanel);

    expect(await screen.findByLabelText("User profile")).toBeTruthy();
    expect(screen.getByText("Profile proxy")).toBeTruthy();
    expect(screen.getByText("Team proxy")).toBeTruthy();
    expect(screen.queryByLabelText("Request proxy route")).toBeNull();
  });

  it("lets the request body editor consume the available vertical space", async () => {
    const req = {
      ...newRequest("req-body"),
      body: {
        type: "json" as const,
        content: '{\n  "ok": true\n}',
        fields: [],
      },
    };
    ws.collections = [
      {
        id: "col-1",
        collection: {
          name: "API",
          order: ["req-body"],
          folders: [],
          rootOrder: [],
          vars: {},
          auth: { type: "none" },
          cookieJar: false,
          defaultProfileId: "",
          defaultHeaders: [],
        },
        requests: [req],
        environments: [],
      },
    ];
    ws.activeColId = "col-1";
    ws.activeReq = req;

    const { container } = render(RequestPanel);
    await fireEvent.click(screen.getByText("Body"));

    const tabFrame = container.querySelector<HTMLElement>(
      '[data-slot="request-tab-frame"]'
    );
    const tabScroll = container.querySelector<HTMLElement>(
      '[data-slot="request-tab-scroll"]'
    );
    const bodyTab = container.querySelector<HTMLElement>(
      '[data-slot="request-body-tab"]'
    );
    const textarea = screen.getByLabelText("Request body");
    const editor = textarea.closest<HTMLElement>('[data-slot="var-field"]');

    expect(tabFrame?.className).toContain("flex-1");
    expect(tabFrame?.className).toContain("flex-col");
    expect(tabScroll?.className).toContain("flex-1");
    expect(tabScroll?.className).toContain("flex-col");
    expect(bodyTab?.className).toContain("flex-1");
    expect(editor?.className).toContain("h-full");
    expect(editor?.className).toContain("flex-1");
    expect(textarea.className).toContain("h-full");
  });

  it("shows inherited headers with scope labels and persists toggles", async () => {
    const req = {
      ...newRequest("req-headers"),
      folder: "Admin",
      disabledInheritedHeaders: ["x-trace"],
    };
    ws.collections = [
      {
        id: "col-1",
        collection: collectionFileSchema.parse({
          name: "Scoped API",
          order: ["req-headers"],
          defaultHeaders: [
            { name: "X-Trace", value: "collection", enabled: true },
          ],
          folders: [
            {
              name: "Admin",
              headers: [{ name: "X-Team", value: "folder", enabled: true }],
            },
          ],
        }),
        requests: [req],
        environments: [],
      },
    ];
    ws.activeColId = "col-1";
    ws.activeReq = req;

    render(RequestPanel);
    await fireEvent.click(screen.getByText("Headers"));

    expect(screen.getByLabelText("source folder")).toBeTruthy();
    expect(screen.getByLabelText("source collection")).toBeTruthy();
    expect(screen.getByLabelText("inherited header X-Team")).toBeTruthy();
    expect(screen.getByLabelText("inherited header X-Trace")).toBeTruthy();
    expect(
      (screen.getByLabelText("inherit X-Team") as HTMLInputElement).checked
    ).toBe(true);
    expect(
      (screen.getByLabelText("inherit X-Trace") as HTMLInputElement).checked
    ).toBe(false);

    await fireEvent.click(screen.getByLabelText("inherit X-Team"));

    expect(ws.activeReq.disabledInheritedHeaders).toEqual([
      "x-team",
      "x-trace",
    ]);
    expect(repo.saveRequest).toHaveBeenCalledWith(
      "col-1",
      expect.objectContaining({
        id: "req-headers",
        disabledInheritedHeaders: ["x-team", "x-trace"],
      })
    );
  });
});
