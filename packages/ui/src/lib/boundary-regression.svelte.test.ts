// Repro for the v0.40.x "black screen" pattern: when a child component
// throws during mount (a stale profileId, a bad lazy import, anything),
// the user used to get nothing. The +page boundary must now catch it
// and surface the error with a Retry / Reload button.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { collectionFileSchema, newRequest } from "@red-request/core";
import { render, screen, waitFor } from "@testing-library/svelte";

vi.mock("./tauri", () => ({ isTauri: true }));
vi.mock("./project", () => ({
  projectInfo: vi.fn(async () => ({
    db_path: "/tmp/fake/app.rdb",
    project_dir: "/tmp/fake",
    is_project: true,
    arg_launched: true,
    name: null,
  })),
  openProject: vi.fn(),
  resetIncompatibleDb: vi.fn(),
  recentSetCount: vi.fn(),
  recentRename: vi.fn(),
  recentRemove: vi.fn(),
  deleteProjectData: vi.fn(),
  projectLabel: vi.fn(() => "project"),
  recentList: vi.fn(async () => []),
}));
vi.mock("./repo", () => ({
  saveRequest: vi.fn(async () => {}),
  saveCollectionMeta: vi.fn(async () => {}),
  saveEnvironment: vi.fn(async () => {}),
  saveEnvironmentOrder: vi.fn(async () => {}),
  renameEnvironment: vi.fn(async () => {}),
  deleteEnvironment: vi.fn(async () => {}),
  saveEnvironmentSecret: vi.fn(async () => {}),
  removeEnvironmentSecret: vi.fn(async () => {}),
  deleteRequest: vi.fn(async () => {}),
  ensureStore: vi.fn(async () => {}),
  runMigrations: vi.fn(async () => {}),
  loadNetwork: vi.fn(async () => ({ proxies: [], profiles: [] })),
  loadUiSettings: vi.fn(async () => ({ redUiEnabled: false })),
  loadEnvironments: vi.fn(async () => []),
  loadAll: vi.fn(async () => []),
  loadGlobals: vi.fn(async () => null),
  recentList: vi.fn(async () => []),
  appVersion: vi.fn(async () => "0.0.0"),
  reddbVersion: vi.fn(async () => "0.0.0"),
}));
vi.mock("./secrets", () => ({}));
vi.mock("./backup", () => ({
  createBackup: vi.fn(),
  listBackups: vi.fn(),
  restoreBackup: vi.fn(),
  deleteBackup: vi.fn(),
  autoBackup: vi.fn(),
}));
vi.mock("./fs", () => ({
  readTextExternal: vi.fn(),
  writeTextExternal: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

// Make the runtime's default +page.svelte render path throw so the
// boundary catches it. The simplest way to force an error inside the
// page tree is to mock a lazy import to return undefined.
vi.mock("$lib/components/HomeView.svelte", () => ({
  default: () => {
    throw new Error("synthetic HomeView crash");
  },
}));

import Page from "../routes/+page.svelte";

describe("+page error boundary", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("surfaces a synthetic HomeView crash instead of going blank", async () => {
    // Patch view to 'home' so the page renders HomeView. We do that by
    // mocking the store after import — easiest path: monkey-patch the
    // store getter. (The default view is 'requests' so the HomeView isn't
    // mounted yet.)
    const storeMod = await import("./store.svelte");
    (storeMod.ws as unknown as { view: string }).view = "home";
    try {
      render(Page);
      // v0.43: each panel has its own nested boundary that names the
      // failing panel — so the user sees "Home failed to render" plus
      // the actual error, not a generic "Something went wrong" full-screen.
      await waitFor(() => {
        expect(document.body.textContent).toContain("Home failed to render");
      });
      // The synthetic message must be surfaced verbatim so the user can
      // grep for it in the bug report.
      expect(document.body.textContent).toContain("synthetic HomeView crash");
    } finally {
      (storeMod.ws as unknown as { view: string }).view = "requests";
    }
  });

  it("keeps titlebar and recovery actions visible during a stuck project load", async () => {
    const repo = await import("./repo");
    vi.mocked(repo.runMigrations).mockImplementationOnce(
      () => new Promise<never>(() => {})
    );

    render(Page);

    await waitFor(() => {
      expect(document.body.textContent).toContain("running migrations");
    });
    expect(screen.getByLabelText("Close window")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export crash report" })
    ).toBeTruthy();
  });
});
