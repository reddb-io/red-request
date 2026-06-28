import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("project transition CSS", () => {
  it("keeps the iris overlay below the titlebar so window controls remain reachable", () => {
    const cssPath = join(process.cwd(), "src/app.css");
    const css = readFileSync(cssPath, "utf8");
    const titlebarPath = join(
      process.cwd(),
      "src/lib/components/Titlebar.svelte"
    );
    const titlebar = readFileSync(titlebarPath, "utf8");
    const irisRule = css.match(/\.iris\s*\{[^}]+\}/)?.[0] ?? "";

    expect(irisRule).toContain("position: fixed");
    expect(irisRule).toContain("inset: 2rem 0 0 0");
    expect(irisRule).toContain("z-index: 100");
    expect(irisRule).toContain("pointer-events: none");
    expect(irisRule).not.toContain("inset: 0;");
    expect(titlebar).toContain("sticky top-0 z-[2000] isolate");
  });
});
