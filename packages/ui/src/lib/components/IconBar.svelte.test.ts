import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

vi.mock("../project", () => ({
  projectLabel: vi.fn(() => "project"),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

import { ws } from "../store.svelte";
import IconBar from "./IconBar.svelte";

async function realClick(target: HTMLElement) {
  await fireEvent.pointerDown(target);
  await fireEvent.mouseDown(target);
  await fireEvent.pointerUp(target);
  await fireEvent.mouseUp(target);
  await fireEvent.click(target);
}

describe("IconBar", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    ws.project = null;
    ws.screen = "app";
    ws.ready = true;
    ws.loading = null;
    ws.loadError = null;
    ws.redUiEnabled = false;
    ws.view = "requests";
  });

  it("switches top-level views when the vertical rail icons are clicked", async () => {
    render(IconBar);

    await realClick(
      screen.getByRole("button", {
        name: "Home: dashboard and network pool",
      })
    );
    await waitFor(() => expect(ws.view).toBe("home"));

    await realClick(
      screen.getByRole("button", {
        name: "Settings: project configuration",
      })
    );
    await waitFor(() => expect(ws.view).toBe("settings"));

    await realClick(
      screen.getByRole("button", {
        name: "Requests: collections and workspace",
      })
    );
    await waitFor(() => expect(ws.view).toBe("requests"));
  });

  it("switches to the database view when the red-ui inspector is enabled", async () => {
    ws.redUiEnabled = true;
    render(IconBar);

    await realClick(
      screen.getByRole("button", {
        name: "Database: inspect request store",
      })
    );

    await waitFor(() => expect(ws.view).toBe("database"));
  });
});
