import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/svelte";

vi.mock("../../repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../repo")>()),
  searchRequests: vi.fn(async () => []),
  loadHistory: vi.fn(async () => []),
}));

import { newRequest } from "@reddb-io/request-core";
import * as repo from "../../repo";
import { ws } from "../../store.svelte";
import CommandPalette from "./CommandPalette.svelte";

describe("CommandPalette", () => {
  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => window.setTimeout(resolve, 30));
  });

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    ws.screen = "app";
    ws.view = "requests";
    ws.settingsSection = "general";
    ws.collections = [];
    ws.activeColId = null;
    ws.activeReq = null;
    ws.redUiEnabled = false;
    ws.network = { proxies: [], profiles: [] };
  });

  it("jumps directly to settings subsections", async () => {
    render(CommandPalette, { props: { open: true } });

    await fireEvent.click(await screen.findByText("Settings: proxies"));

    await waitFor(() => {
      expect(ws.view).toBe("settings");
      expect(ws.settingsSection).toBe("proxies");
    });
  });

  it("creates a collection from the command surface", async () => {
    const addCollection = vi
      .spyOn(ws, "addCollection")
      .mockResolvedValueOnce("col-1");

    render(CommandPalette, { props: { open: true } });

    await fireEvent.click(await screen.findByText("Create collection"));

    await waitFor(() => {
      expect(ws.view).toBe("requests");
      expect(addCollection).toHaveBeenCalledTimes(1);
    });
  });

  it("creates a collection before creating a request when the workspace is empty", async () => {
    const addCollection = vi
      .spyOn(ws, "addCollection")
      .mockImplementationOnce(async () => {
        ws.activeColId = "col-1";
        return "col-1";
      });
    const addRequest = vi
      .spyOn(ws, "addRequest")
      .mockResolvedValueOnce("req-1");

    render(CommandPalette, { props: { open: true } });

    await fireEvent.click(await screen.findByText("New request"));

    await waitFor(() => {
      expect(addCollection).toHaveBeenCalledTimes(1);
      expect(addRequest).toHaveBeenCalledWith("");
    });
  });

  it("runs requests from the command surface in most-recent execution order", async () => {
    const first = { ...newRequest("req-1"), name: "First request" };
    const second = { ...newRequest("req-2"), name: "Second request" };
    ws.collections = [
      {
        id: "col-1",
        collection: {
          name: "API",
          order: ["req-1", "req-2"],
          folders: [],
          vars: {},
          auth: { type: "none" },
          cookieJar: false,
          defaultProfileId: "",
        },
        requests: [first, second],
        environments: [],
      },
    ];
    ws.activeColId = "col-1";
    ws.activeReq = first;
    vi.mocked(repo.loadHistory).mockResolvedValueOnce([
      {
        id: "run-2",
        reqId: "req-2",
        collectionId: "col-1",
        name: "Second request",
        method: "GET",
        url: "https://example.test/second",
        ts: 200,
        status: 200,
        ok: true,
        durationMs: 10,
        size: 0,
        testsPassed: 0,
        testsFailed: 0,
      },
      {
        id: "run-1",
        reqId: "req-1",
        collectionId: "col-1",
        name: "First request",
        method: "GET",
        url: "https://example.test/first",
        ts: 100,
        status: 200,
        ok: true,
        durationMs: 12,
        size: 0,
        testsPassed: 0,
        testsFailed: 0,
      },
    ]);
    const send = vi.spyOn(ws, "send").mockResolvedValueOnce(undefined);

    render(CommandPalette, { props: { open: true } });

    const secondRun = await screen.findByText("Run: Second request");
    const firstRun = await screen.findByText("Run: First request");
    expect(
      secondRun.compareDocumentPosition(firstRun) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    await fireEvent.click(secondRun);

    await waitFor(() => {
      expect(ws.activeReq?.id).toBe("req-2");
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  it("turns off the active request proxy when no profile proxy locks the route", async () => {
    const req = {
      ...newRequest("req-1"),
      name: "Proxied request",
      proxy: "http://old.proxy:8080",
    };
    ws.collections = [
      {
        id: "col-1",
        collection: {
          name: "API",
          order: ["req-1"],
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
          type: "http",
          host: "proxy.internal",
          port: "8080",
          username: "",
          password: "",
        },
      ],
      profiles: [],
    };
    const save = vi.spyOn(ws, "save").mockResolvedValue(undefined);

    render(CommandPalette, { props: { open: true } });

    await fireEvent.click(await screen.findByText("Proxy: direct connection"));

    await waitFor(() => {
      expect(ws.activeReq?.proxy).toBeUndefined();
      expect(save).toHaveBeenCalledTimes(1);
    });
  });

  it("turns on a saved proxy for the active request from the command surface", async () => {
    const req = {
      ...newRequest("req-1"),
      name: "Direct request",
      proxy: undefined,
    };
    ws.collections = [
      {
        id: "col-1",
        collection: {
          name: "API",
          order: ["req-1"],
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
          type: "http",
          host: "proxy.internal",
          port: "8080",
          username: "",
          password: "",
        },
      ],
      profiles: [],
    };
    const save = vi.spyOn(ws, "save").mockResolvedValue(undefined);

    render(CommandPalette, { props: { open: true } });

    await fireEvent.click(await screen.findByText("Proxy: Team proxy"));

    await waitFor(() => {
      expect(ws.activeReq?.proxy).toBe("http://proxy.internal:8080");
      expect(save).toHaveBeenCalledTimes(1);
    });
  });

  it("does not offer request proxy actions when the active profile owns the proxy", async () => {
    const req = {
      ...newRequest("req-1"),
      name: "Profile locked request",
      profileId: "prof-1",
      proxy: "http://request.proxy:8080",
    };
    ws.collections = [
      {
        id: "col-1",
        collection: {
          name: "API",
          order: ["req-1"],
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
          type: "http",
          host: "proxy.internal",
          port: "8080",
          username: "",
          password: "",
        },
      ],
      profiles: [
        {
          id: "prof-1",
          name: "Team profile",
          userAgent: "",
          headers: [],
          proxyId: "px-team",
        },
      ],
    };
    const save = vi.spyOn(ws, "save").mockResolvedValue(undefined);

    render(CommandPalette, { props: { open: true } });

    expect(screen.queryByText("Proxy: direct connection")).toBeNull();
    expect(screen.queryByText("Proxy: Team proxy")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
});
