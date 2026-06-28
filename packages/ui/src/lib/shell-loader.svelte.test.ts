import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";

vi.mock("$lib/components/AppShell.svelte", () => new Promise<never>(() => {}));

import ShellLoader from "$lib/components/ShellLoader.svelte";
import Page from "../routes/+page.svelte";

describe("ShellLoader recovery", () => {
  it("turns a stuck app shell chunk into a recovery screen", async () => {
    vi.useFakeTimers();

    render(ShellLoader);
    expect(document.body.textContent).toContain("loading shell");

    await vi.advanceTimersByTimeAsync(16_000);

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Project shell failed to start"
      );
    });
    expect(document.body.textContent).toContain("Shell loading timed out");
    expect(screen.getByRole("button", { name: "Retry shell" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export crash report" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Choose another project" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload window" })).toBeTruthy();
  });

  it("keeps the route titlebar visible when the app shell chunk is stuck", async () => {
    vi.useFakeTimers();

    render(Page);

    expect(screen.getByLabelText("Close window")).toBeTruthy();
    expect(screen.getByLabelText("Minimize window")).toBeTruthy();
    expect(document.body.textContent).toContain("Red Request");
    expect(document.body.textContent).toContain("loading shell");

    await vi.advanceTimersByTimeAsync(16_000);

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Project shell failed to start"
      );
    });
    expect(screen.getByLabelText("Close window")).toBeTruthy();
    expect(screen.getByLabelText("Minimize window")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry shell" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export crash report" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Choose another project" })
    ).toBeTruthy();
  });
});
