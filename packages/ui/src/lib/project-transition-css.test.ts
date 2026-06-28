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

  it("keeps the primary rail above recovery overlays and outside their hit area", () => {
    const pagePath = join(process.cwd(), "src/routes/+page.svelte");
    const page = readFileSync(pagePath, "utf8");
    const iconBarPath = join(
      process.cwd(),
      "src/lib/components/IconBar.svelte"
    );
    const iconBar = readFileSync(iconBarPath, "utf8");

    expect(iconBar).toContain("relative z-[1000]");
    expect(page).toContain("pointer-events-none fixed right-3 top-11 z-[950]");
    expect(page).toContain(
      "pointer-events-auto flex flex-wrap items-center gap-2"
    );
  });
});
