import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/svelte";
import VarField from "./VarField.svelte";

describe("VarField", () => {
  afterEach(() => {
    cleanup();
  });

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

  it("lets the line-number editor fill the available parent height", () => {
    const { container } = render(VarField, {
      value: '{\n  "ok": true\n}',
      multiline: true,
      lineNumbers: true,
      fill: true,
      ariaLabel: "Request body",
    });

    const editor = container.querySelector<HTMLElement>(
      '[data-slot="var-field"]'
    );
    const gutter = container.querySelector<HTMLElement>(
      '[data-slot="var-field-gutter"]'
    );
    const textarea = screen.getByLabelText("Request body");

    expect(editor?.className).toContain("flex-1");
    expect(editor?.getAttribute("style") ?? "").not.toContain("height:");
    expect(gutter?.style.height).toBe("100%");
    expect(textarea.className).toContain("h-full");
  });

  it("lets wrapped multiline editors fill the available parent height", () => {
    const { container } = render(VarField, {
      value: "wrapped body",
      multiline: true,
      lineNumbers: true,
      wrap: true,
      fill: true,
      ariaLabel: "Request body",
    });

    const editor = container.querySelector<HTMLElement>(
      '[data-slot="var-field"]'
    );
    const textarea = screen.getByLabelText("Request body");

    expect(editor?.className).toContain("h-full");
    expect(editor?.className).toContain("flex-1");
    expect(textarea.className).toContain("h-full");
    expect(textarea.className).toContain("overflow-auto");
  });

  it("opens a wide suggestions menu without overflowing the viewport", async () => {
    Object.defineProperty(window, "innerWidth", {
      value: 800,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: 600,
      configurable: true,
    });

    const { container } = render(VarField, {
      value: "{{",
      known: ["api_host"],
      values: {
        api_host:
          "A very long value description that should not hide the variable name column",
      },
      ariaLabel: "URL",
    });
    const input = screen.getByLabelText("URL");
    input.getBoundingClientRect = () =>
      ({
        left: 720,
        right: 780,
        top: 100,
        bottom: 128,
        width: 60,
        height: 28,
        x: 720,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect;

    (input as HTMLInputElement).setSelectionRange(2, 2);
    await fireEvent.click(input);

    const menu = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(
        '[data-slot="var-field-menu"]'
      );
      expect(el).toBeTruthy();
      return el!;
    });

    await waitFor(() => expect(menu.style.width).toBe("576px"));
    expect(menu.className).toContain("fixed");
    expect(parseInt(menu.style.width, 10)).toBe(576);
    expect(
      parseInt(menu.style.left, 10) + parseInt(menu.style.width, 10)
    ).toBeLessThanOrEqual(788);
    expect(await screen.findByText("api_host")).toBeTruthy();
  });
});
