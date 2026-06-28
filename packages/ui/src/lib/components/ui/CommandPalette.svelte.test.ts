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
}));

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
});
