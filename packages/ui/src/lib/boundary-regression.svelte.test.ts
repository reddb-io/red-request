// Repro for the v0.40.x "black screen" pattern: when a child component
// throws during mount (a stale profileId, a bad lazy import, anything),
// the user used to get nothing. The +page boundary must now catch it
// and surface the error with a Retry / Reload button.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { collectionFileSchema, newRequest } from "@red-request/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/svelte";

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
  syncConsumerName: vi.fn(async () => "rr_client"),
  currentSyncClientId: vi.fn(async () => "client-1"),
  readSyncEvents: vi.fn(() => new Promise<never>(() => {})),
  ackSyncEvent: vi.fn(async () => {}),
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
import { ws } from "./store.svelte";

describe("+page error boundary", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    ws.ready = false;
    ws.bridgeMissing = false;
    ws.loadError = null;
    ws.closing = false;
    ws.screen = "selector";
    ws.transitioning = false;
    ws.transitionPhase = "idle";
    ws.loading = null;
    ws.openingTarget = null;
    ws.project = null;
    ws.view = "requests";
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
    expect(
      screen.getByRole("button", { name: "Choose another project" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry opening" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Export crash report" })
    ).toBeTruthy();
  });

  it("offers strong recovery actions when project opening stays stuck behind the transition", async () => {
    const project = await import("./project");
    const storeMod = await import("./store.svelte");
    vi.mocked(project.projectInfo).mockResolvedValueOnce({
      db_path: "/tmp/fake/app.rdb",
      project_dir: "/tmp/fake",
      is_project: true,
      arg_launched: false,
      name: null,
    });
    render(Page);

    await waitFor(() => {
      expect(storeMod.ws.ready).toBe(true);
      expect(storeMod.ws.loading).toBeNull();
    });

    storeMod.ws.ready = true;
    storeMod.ws.screen = "app";
    storeMod.ws.project = {
      db_path: "/tmp/fake/app.rdb",
      project_dir: "/tmp/fake",
      is_project: true,
      arg_launched: false,
      name: "fake",
    };
    storeMod.ws.transitioning = true;
    storeMod.ws.transitionPhase = "hold";
    storeMod.ws.loading = {
      startedAt: Date.now() - 12_000,
      step: "opening database file",
      log: [{ ts: Date.now() - 12_000, step: "opening database file" }],
    };

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "This is taking longer than expected"
      );
    });
    expect(screen.getByLabelText("Close window")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Choose another project" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry opening" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop waiting" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Delete local data" })
    ).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "Stop waiting" }));

    await waitFor(() => {
      expect(storeMod.ws.transitioning).toBe(false);
      expect(storeMod.ws.loading).toBeNull();
      expect(document.body.textContent).toContain(
        "Project opening was stopped"
      );
    });
    expect(document.querySelector(".iris")).toBeNull();
    expect(screen.getByLabelText("Close window")).toBeTruthy();
  });

  it("prioritizes project recovery over a stale loading overlay", async () => {
    const project = await import("./project");
    const storeMod = await import("./store.svelte");
    vi.mocked(project.projectInfo).mockResolvedValueOnce({
      db_path: "/tmp/fake/app.rdb",
      project_dir: "/tmp/fake",
      is_project: true,
      arg_launched: false,
      name: null,
    });
    render(Page);

    await waitFor(() => {
      expect(storeMod.ws.ready).toBe(true);
    });

    storeMod.ws.ready = true;
    storeMod.ws.screen = "app";
    storeMod.ws.project = {
      db_path: "/tmp/fake/app.rdb",
      project_dir: "/tmp/fake",
      is_project: true,
      arg_launched: false,
      name: "fake",
    };
    storeMod.ws.loadError = "Opening project timed out after 15s: /tmp/fake";
    storeMod.ws.loading = {
      startedAt: Date.now(),
      step: "opening database file",
      log: [{ ts: Date.now(), step: "opening database file" }],
    };

    await waitFor(() => {
      expect(document.body.textContent).toContain("Retry");
    });
    expect(document.body.textContent).toContain("Rebuild database");
    expect(document.body.textContent).toContain("Choose another project");
    expect(document.body.textContent).not.toContain("Opening project…");
    expect(screen.getByLabelText("Close window")).toBeTruthy();
  });
});
