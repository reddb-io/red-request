import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { developerConsole } from "$lib/developer-console.svelte";

import DeveloperConsole from "./DeveloperConsole.svelte";

beforeEach(() => {
  developerConsole.clear();
  developerConsole.open = false;
  developerConsole.setFilter("all");
});

describe("DeveloperConsole", () => {
  it("starts collapsed and shows the latest activity summary", () => {
    developerConsole.logApp("info", "loadStore: done");

    render(DeveloperConsole);

    expect(
      screen.getByRole("button", { name: "Open developer console" })
    ).toBeTruthy();
    expect(screen.getByText("Developer")).toBeTruthy();
    expect(screen.getByText("1 events")).toBeTruthy();
    expect(screen.getByText(/loadStore: done/)).toBeTruthy();
    expect(screen.queryByText("App and RedDB activity")).toBeNull();
  });

  it("opens, filters events, and clears the buffer", async () => {
    developerConsole.logApp("info", "boot");
    developerConsole.logReddbHttp({
      method: "GET",
      path: "/stats",
      ok: true,
      status: 200,
      durationMs: 9,
    });

    render(DeveloperConsole);
    await fireEvent.click(
      screen.getByRole("button", { name: "Open developer console" })
    );

    expect(screen.getByText("App and RedDB activity")).toBeTruthy();
    expect(screen.getAllByText("GET /stats").length).toBeGreaterThan(0);
    expect(screen.getByText("boot")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "RedDB" }));
    expect(screen.getAllByText("GET /stats").length).toBeGreaterThan(0);
    expect(screen.queryByText("boot")).toBeNull();

    await fireEvent.click(
      screen.getByRole("button", { name: "Clear developer console" })
    );
    expect(screen.getByText("No events for this filter.")).toBeTruthy();
  });
});
