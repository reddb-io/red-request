import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import VarField from "./VarField.svelte";

describe("VarField", () => {
  it("keeps the line-number editor constrained to the textarea viewport", () => {
    const value = Array.from({ length: 80 }, (_, i) => `"line${i}": true`).join(
      "\n"
    );

    const { container } = render(VarField, {
      value,
      multiline: true,
      lineNumbers: true,
      rows: 12,
      ariaLabel: "Request body",
    });

    const editor = container.querySelector('[data-slot="var-field"]');
    const gutter = container.querySelector('[data-slot="var-field-gutter"]');
    const pane = container.querySelector('[data-slot="var-field-editor-pane"]');
    const textarea = screen.getByLabelText("Request body");

    expect(editor?.getAttribute("style")).toContain("height:");
    expect(gutter?.getAttribute("style")).toContain("height:");
    expect(pane?.className).toContain("h-full");
    expect(textarea.className).toContain("h-full");
    expect(textarea.className).toContain("overflow-auto");
  });
});
