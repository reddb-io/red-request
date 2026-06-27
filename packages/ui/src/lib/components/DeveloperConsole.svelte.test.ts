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
  it("starts collapsed and shows the event count in the header", () => {
    developerConsole.logApp("info", "loadStore: done");

    render(DeveloperConsole);

    expect(
      screen.getByRole("button", { name: "Open developer console" })
    ).toBeTruthy();
    expect(screen.getByText("Developer")).toBeTruthy();
    // Compact count: no "events" suffix, no inline latest preview.
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.queryByText(/loadStore: done/)).toBeNull();
  });

  it("opens to a two-column layout and clears the buffer", async () => {
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

    expect(screen.getAllByText("GET /stats").length).toBeGreaterThan(0);
    expect(screen.getByText("boot")).toBeTruthy();
    // Empty-state on the detail pane until the user picks an entry.
    expect(
      screen.getAllByText(/Select a log entry to inspect/).length
    ).toBeGreaterThan(0);

    await fireEvent.click(screen.getByRole("button", { name: "RedDB" }));
    expect(screen.getAllByText("GET /stats").length).toBeGreaterThan(0);
    expect(screen.queryByText("boot")).toBeNull();

    await fireEvent.click(
      screen.getByRole("button", { name: "Clear developer console" })
    );
    // After clear: the buffer is empty, so the list pane shows the cold-start hint.
    expect(screen.getByText(/No activity yet/)).toBeTruthy();
  });

  it("selects an entry to load the right-pane detail", async () => {
    developerConsole.logApp("info", "boot");

    render(DeveloperConsole);
    await fireEvent.click(
      screen.getByRole("button", { name: "Open developer console" })
    );

    // Empty-state hint visible before any selection.
    expect(
      screen.getAllByText(/Select a log entry to inspect/).length
    ).toBeGreaterThan(0);

    // The list row is a <button> with aria-pressed; the empty-state hint text
    // also contains "boot" but lives inside a <p>, so scoping to aria-pressed
    // targets the row directly.
    const rows = screen.getAllByRole("button", { pressed: false });
    const bootRow = rows.find((b) => b.textContent?.includes("boot"));
    expect(bootRow).toBeTruthy();
    await fireEvent.click(bootRow!);
    const pre = document.querySelector("pre.mono");
    expect(pre?.textContent).toContain("boot");
  });

  it("renders the RQL payload (the response RedDB sent back) in the right pane", async () => {
    // Simulate a SELECT that returned 2 rows. The payload is what students
    // would read to learn RedDB — the same JSON RedDB itself produced.
    developerConsole.logReddbRql({
      query: "SELECT name, model FROM red.collections",
      ok: true,
      durationMs: 7,
      rows: 2,
      payload: JSON.stringify(
        {
          columns: ["name", "model"],
          records: [
            { name: "rr_requests", model: "document" },
            { name: "rr_collections", model: "kv" },
          ],
        },
        null,
        2
      ),
    });

    render(DeveloperConsole);
    await fireEvent.click(
      screen.getByRole("button", { name: "Open developer console" })
    );

    const rows = screen.getAllByRole("button", { pressed: false });
    await fireEvent.click(
      rows.find((b) => b.textContent?.includes("SELECT red.collections"))!
    );

    // The right pane renders two labelled sections (REQUEST + RESPONSE) so the
    // student sees both the query that was issued and the rows RedDB returned.
    expect(screen.getByText("Request")).toBeTruthy();
    expect(screen.getByText("Response")).toBeTruthy();
    const pres = document.querySelectorAll("pre.mono");
    const all = Array.from(pres)
      .map((p) => p.textContent)
      .join("\n");
    expect(all).toContain("SELECT name, model FROM red.collections");
    expect(all).toContain('"rr_requests"');
    expect(all).toContain('"document"');
  });

  it("renders HTTP error response payload with the 5xx body", async () => {
    developerConsole.logReddbHttp({
      method: "POST",
      path: "/v1/kv/rr_settings",
      ok: false,
      status: 500,
      durationMs: 12,
      bodyBytes: 47,
      error: "internal error",
      payload: '{"error":"internal: corrupt page header"}',
    });

    render(DeveloperConsole);
    await fireEvent.click(
      screen.getByRole("button", { name: "Open developer console" })
    );

    const rows = screen.getAllByRole("button", { pressed: false });
    await fireEvent.click(
      rows.find((b) => b.textContent?.includes("POST /v1/kv"))!
    );

    const pres = document.querySelectorAll("pre.mono");
    const all = Array.from(pres)
      .map((p) => p.textContent)
      .join("\n");
    expect(all).toContain("corrupt page header");
    // Byte size renders next to the RESPONSE label. `meta` also renders the
    // status code "500" alongside the size, so use getAllByText to accept both.
    expect(screen.getAllByText(/\d+ B/).length).toBeGreaterThan(0);
  });
});
