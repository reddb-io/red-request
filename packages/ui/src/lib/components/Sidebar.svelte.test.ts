import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/svelte";
import { newRequest } from "@reddb-io/request-core";

import { ws } from "../store.svelte";
import SidebarHarness from "../test/SidebarHarness.svelte";

describe("Sidebar inline rename gestures", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const req = {
      ...newRequest("req-1"),
      name: "List users",
      method: "GET" as const,
      url: "https://api.example.test/users",
    };
    ws.project = null;
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
        requests: [req],
        environments: [],
      },
    ];
    ws.activeColId = "col-1";
    ws.activeReq = req;
    ws.network = { proxies: [], profiles: [] };
  });

  afterEach(() => {
    cleanup();
  });

  it("renames a request after double-clicking its name", async () => {
    const renameRequest = vi.spyOn(ws, "renameRequest").mockResolvedValue();

    render(SidebarHarness);

    await fireEvent.dblClick(screen.getByText("List users"));
    const input = await screen.findByDisplayValue("List users");
    await fireEvent.input(input, { target: { value: "Fetch users" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(renameRequest).toHaveBeenCalledWith("req-1", "Fetch users");
    });
  });

  it("renames a collection after double-clicking its name", async () => {
    const renameCollection = vi
      .spyOn(ws, "renameCollection")
      .mockResolvedValue();

    render(SidebarHarness);

    await fireEvent.dblClick(screen.getByText("Team API"));
    const input = await screen.findByDisplayValue("Team API");
    await fireEvent.input(input, { target: { value: "Platform API" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(renameCollection).toHaveBeenCalledWith("col-1", "Platform API");
    });
  });
});
