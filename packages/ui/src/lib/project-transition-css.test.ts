import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("project transition CSS", () => {
  it("does not mount the black iris transition during project open", () => {
    const pagePath = join(process.cwd(), "src/routes/+page.svelte");
    const page = readFileSync(pagePath, "utf8");
    const titlebarPath = join(
      process.cwd(),
      "src/lib/components/Titlebar.svelte"
    );
    const titlebar = readFileSync(titlebarPath, "utf8");

    expect(page).not.toContain("ProjectTransition");
    expect(page).not.toContain("<ProjectTransition");
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
