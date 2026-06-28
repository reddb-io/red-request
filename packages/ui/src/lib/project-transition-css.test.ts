import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
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
    const cssPath = join(process.cwd(), "src/app.css");
    const css = readFileSync(cssPath, "utf8");
    const transitionPath = join(
      process.cwd(),
      "src/lib/components/ProjectTransition.svelte"
    );

    expect(existsSync(transitionPath)).toBe(false);
    expect(page).not.toContain("ProjectTransition");
    expect(page).not.toContain("<ProjectTransition");
    expect(css).not.toContain(".iris");
    expect(css).not.toContain("box-shadow: 0 0 0 115vmax #000");
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

    expect(iconBar).toContain("pointer-events-auto relative z-[3000] isolate");
    expect(iconBar).toContain("onpointerdowncapture={handleRailActivation}");
    expect(iconBar).toContain("onmousedowncapture={handleRailActivation}");
    expect(iconBar).toContain("onclickcapture={handleRailActivation}");
    expect(page).toContain("pointer-events-none fixed right-3 top-11 z-[950]");
    expect(page).toContain(
      "pointer-events-auto flex flex-wrap items-center gap-2"
    );
  });

  it("keeps root chrome resilient to Tauri window import and boot crashes", () => {
    const pagePath = join(process.cwd(), "src/routes/+page.svelte");
    const page = readFileSync(pagePath, "utf8");
    const titlebarPath = join(
      process.cwd(),
      "src/lib/components/Titlebar.svelte"
    );
    const titlebar = readFileSync(titlebarPath, "utf8");

    expect(page).not.toContain(
      'import { getCurrentWindow } from "@tauri-apps/api/window"'
    );
    expect(titlebar).not.toContain(
      'import { getCurrentWindow } from "@tauri-apps/api/window"'
    );
    expect(page).toContain('window.addEventListener("error", onGlobalError)');
    expect(page).toContain(
      'window.addEventListener("unhandledrejection", onUnhandledRejection)'
    );
    expect(page).toContain("ws.forceOpenRecovery(`${source}: ${detail}`)");
  });

  it("keeps the titlebar outside fragile providers and gives shell crashes recovery actions", () => {
    const pagePath = join(process.cwd(), "src/routes/+page.svelte");
    const page = readFileSync(pagePath, "utf8");
    const titlebarIndex = page.indexOf("<Titlebar />");
    const shellBoundaryIndex = page.indexOf("failed={shellFailed}");
    const tooltipProviderIndex = page.indexOf("<Tooltip.Provider");

    expect(titlebarIndex).toBeGreaterThan(-1);
    expect(shellBoundaryIndex).toBeGreaterThan(titlebarIndex);
    expect(tooltipProviderIndex).toBeGreaterThan(shellBoundaryIndex);
    expect(page).toContain("{#snippet shellFailed");
    expect(page).toContain("Project shell failed");
    expect(page).toContain("Retry shell");
    expect(page).toContain("Export crash report");
    expect(page).toContain("Choose another project");
    expect(page).toContain("Reload window");
  });
});
