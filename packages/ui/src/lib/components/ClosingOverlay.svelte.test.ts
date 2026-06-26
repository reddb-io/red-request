import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";

import ClosingOverlay from "./ClosingOverlay.svelte";

describe("ClosingOverlay", () => {
  it("announces that the app is closing", () => {
    render(ClosingOverlay);

    expect(screen.getByRole("status", { name: "Closing" })).toBeTruthy();
    expect(screen.getByText("Closing...")).toBeTruthy();
    expect(screen.getByText(/Red Request is finishing up/i)).toBeTruthy();
  });
});
