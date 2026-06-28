import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("project transition CSS", () => {
  it("does not mount the black iris transition during project open", () => {
    const pagePath = join(process.cwd(), "src/routes/+page.svelte");
    const page = readFileSync(pagePath, "utf8");
    const appShellPath = join(
      process.cwd(),
      "src/lib/components/AppShell.svelte"
    );
    const appShell = readFileSync(appShellPath, "utf8");
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
    expect(appShell).not.toContain("ProjectTransition");
    expect(appShell).not.toContain("<ProjectTransition");
    expect(css).not.toContain(".iris");
    expect(css).not.toContain("box-shadow: 0 0 0 115vmax #000");
    expect(titlebar).toContain("sticky top-0 z-[2000] isolate");
  });

  it("keeps the primary rail above recovery overlays and outside their hit area", () => {
    const appShellPath = join(
      process.cwd(),
      "src/lib/components/AppShell.svelte"
    );
    const appShell = readFileSync(appShellPath, "utf8");
    const iconBarPath = join(
      process.cwd(),
      "src/lib/components/IconBar.svelte"
    );
    const iconBar = readFileSync(iconBarPath, "utf8");

    expect(iconBar).toContain("pointer-events-auto relative z-[3000] isolate");
    expect(iconBar).toContain("onpointerdowncapture={handleRailActivation}");
    expect(iconBar).toContain("onmousedowncapture={handleRailActivation}");
    expect(iconBar).toContain("onclickcapture={handleRailActivation}");
    expect(appShell).toContain(
      "pointer-events-none fixed right-3 top-11 z-[950]"
    );
    expect(appShell).toContain(
      "pointer-events-auto flex flex-wrap items-center gap-2"
    );
  });

  it("keeps root chrome resilient to Tauri window import and boot crashes", () => {
    const pagePath = join(process.cwd(), "src/routes/+page.svelte");
    const page = readFileSync(pagePath, "utf8");
    const appShellPath = join(
      process.cwd(),
      "src/lib/components/AppShell.svelte"
    );
    const appShell = readFileSync(appShellPath, "utf8");
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
    expect(appShell).toContain(
      'window.addEventListener("error", onGlobalError)'
    );
    expect(appShell).toContain(
      'window.addEventListener("unhandledrejection", onUnhandledRejection)'
    );
    expect(appShell).toContain("ws.forceOpenRecovery(`${source}: ${detail}`)");
  });

  it("keeps the titlebar outside fragile providers and gives shell crashes recovery actions", () => {
    const pagePath = join(process.cwd(), "src/routes/+page.svelte");
    const page = readFileSync(pagePath, "utf8");
    const appShellPath = join(
      process.cwd(),
      "src/lib/components/AppShell.svelte"
    );
    const appShell = readFileSync(appShellPath, "utf8");
    const shellLoaderPath = join(
      process.cwd(),
      "src/lib/components/ShellLoader.svelte"
    );
    const shellLoader = readFileSync(shellLoaderPath, "utf8");
    const titlebarIndex = page.indexOf("<Titlebar />");

    expect(titlebarIndex).toBeGreaterThan(-1);
    expect(page).toContain("<ShellLoader />");
    expect(appShell).toContain("{#snippet shellFailed");
    expect(appShell).toContain("Project shell failed");
    expect(appShell).toContain("<Tooltip.Provider");
    expect(shellLoader).toContain("{#snippet bootFailed");
    expect(shellLoader).toContain("Project shell failed to start");
    expect(shellLoader).toContain("Retry shell");
    expect(shellLoader).toContain("Export crash report");
    expect(shellLoader).toContain("Choose another project");
    expect(shellLoader).toContain("Reload window");
  });

  it("keeps the route module free of fragile workspace imports", () => {
    const pagePath = join(process.cwd(), "src/routes/+page.svelte");
    const page = readFileSync(pagePath, "utf8");

    for (const component of [
      "DeveloperConsole",
      "IconBar",
      "Sidebar",
      "RequestPanel",
      "ResponsePanel",
      "HomeView",
      "ProjectSelector",
    ]) {
      expect(page).not.toContain(
        `import ${component} from "$lib/components/${component}.svelte"`
      );
    }
    expect(page).not.toContain('import { ws } from "$lib/store.svelte"');
    expect(page).toContain(
      'import Titlebar from "$lib/components/Titlebar.svelte"'
    );
    expect(page).toContain(
      'import ShellLoader from "$lib/components/ShellLoader.svelte"'
    );
  });
});
