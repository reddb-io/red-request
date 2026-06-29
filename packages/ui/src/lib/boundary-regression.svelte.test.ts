// Repro for the v0.40.x "black screen" pattern: when a child component
// throws during mount (a stale profileId, a bad lazy import, anything),
// the user used to get nothing. The app shell boundaries must now catch it
// while the titlebar remains mounted by the route-level shell.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { collectionFileSchema, newRequest } from "@reddb-io/request-core";
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
  setProjectSyncQueueEnabled: vi.fn(),
  syncConsumerName: vi.fn(async () => "rr_client"),
  currentSyncClientId: vi.fn(async () => "client-1"),
  readSyncEvents: vi.fn(() => new Promise<never>(() => {})),
  ackSyncEvent: vi.fn(async () => {}),
  recordCounts: vi.fn(async () => ({
    total: 0,
    byKind: [],
  })),
  migrationSummary: vi.fn(async () => ({
    applied: 0,
    pending: 0,
    failed: 0,
  })),
  recentList: vi.fn(async () => []),
  appVersion: vi.fn(async () => "0.0.0"),
  reddbVersion: vi.fn(async () => "0.0.0"),
}));
vi.mock("./secrets", () => ({}));
vi.mock("./backup", () => ({
  createBackup: vi.fn(async () => null),
  listBackups: vi.fn(async () => []),
  restoreBackup: vi.fn(async () => {}),
  deleteBackup: vi.fn(async () => {}),
  autoBackup: vi.fn(async () => {}),
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

import AppShellHarness from "./test/AppShellHarness.svelte";
import { ws } from "./store.svelte";

function expectButton(name: string) {
  expect(screen.getAllByRole("button", { name }).length).toBeGreaterThan(0);
}

describe("+page error boundary", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
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
    ws.creatingCollection = false;
    ws.deletingCollectionIds = {};
    ws.deletingProjectData = false;
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
      render(AppShellHarness);
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

    render(AppShellHarness);

    await waitFor(() => {
      expect(document.body.textContent).toContain("running migrations");
    });
    expect(screen.getByLabelText("Close window")).toBeTruthy();
    expect(screen.getByTestId("project-recovery-dock")).toBeTruthy();
    expectButton("Choose another project");
    expectButton("Retry opening");
    expectButton("Export crash report");
  });

  it("exits a stuck startup before project info into recovery", async () => {
    vi.useFakeTimers();
    const project = await import("./project");
    const storeMod = await import("./store.svelte");
    vi.mocked(project.projectInfo).mockImplementationOnce(
      () => new Promise<never>(() => {})
    );

    render(AppShellHarness);

    await vi.advanceTimersByTimeAsync(16_000);

    await waitFor(() => {
      expect(storeMod.ws.ready).toBe(true);
      expect(storeMod.ws.loadError).toContain("Startup");
    });
    expect(document.body.textContent).not.toBe("loading…");
    expect(screen.getByLabelText("Close window")).toBeTruthy();
    expect(screen.getByTestId("project-recovery-dock")).toBeTruthy();
    expectButton("Retry");
    expectButton("Export crash report");
    expectButton("Choose another project");
  });

  it("automatically exits an aged loading state into recovery instead of waiting forever", async () => {
    const storeMod = await import("./store.svelte");
    render(AppShellHarness);

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
    storeMod.ws.loadError = null;
    storeMod.ws.loading = {
      startedAt: Date.now() - 31_000,
      step: "opening database file",
      log: [{ ts: Date.now() - 31_000, step: "opening database file" }],
    };

    await waitFor(() => {
      expect(storeMod.ws.loading).toBeNull();
      expect(storeMod.ws.loadError).toContain("failsafe");
    });
    expect(screen.getByLabelText("Close window")).toBeTruthy();
    expect(screen.getByTestId("project-recovery-dock")).toBeTruthy();
    expectButton("Retry");
    expectButton("Choose another project");
  });

  it("renders onboarding, not recovery, when a new project opens with no collections", async () => {
    render(AppShellHarness);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Start this project");
    });
    expect(screen.getByLabelText("Close window")).toBeTruthy();
    expectButton("Create collection");
    expectButton("Choose another project");
    expect(document.body.textContent).toContain(
      "This is a fresh Red Request workspace"
    );
    expect(document.body.textContent).not.toContain("Export crash report");
    expect(document.body.textContent).not.toContain("Retry opening");
    expect(document.body.textContent).not.toContain("Delete local data");
  });

  it("locks the onboarding collection create action while the first collection is saving", async () => {
    const repo = await import("./repo");
    vi.mocked(repo.saveCollectionMeta).mockImplementation(
      () => new Promise<never>(() => {})
    );
    render(AppShellHarness);

    const button = await screen.findByRole("button", {
      name: "Create collection",
    });

    await fireEvent.click(button);
    await fireEvent.click(button);

    expect(repo.saveCollectionMeta).toHaveBeenCalledTimes(1);
    expect(
      (
        screen.getByRole("button", {
          name: "Creating collection...",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
  });

  it("keeps titlebar and recovery visible when pending autosave blocks project switch", async () => {
    const repo = await import("./repo");
    const storeMod = await import("./store.svelte");
    render(AppShellHarness);

    await waitFor(() => {
      expect(document.body.textContent).toContain("Start this project");
    });

    vi.useFakeTimers();
    vi.mocked(repo.saveRequest).mockImplementationOnce(
      () => new Promise<never>(() => {})
    );
    const req = newRequest("r1");
    storeMod.ws.collections = [
      {
        id: "c1",
        collection: collectionFileSchema.parse({
          name: "c1",
          order: ["r1"],
        }),
        requests: [req],
        environments: [],
      },
    ];
    storeMod.ws.activeColId = "c1";
    storeMod.ws.activeReq = { ...req, url: "https://example.test" };
    storeMod.ws.scheduleSave();

    void storeMod.ws.chooseProject("/tmp/new-project");
    await vi.advanceTimersByTimeAsync(0);

    expect(document.body.textContent).toContain(
      "saving current project before switching"
    );
    expect(screen.getByLabelText("Close window")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(6_000);

    expect(document.body.textContent).toContain(
      "Could not finish saving current project before switching"
    );
    expect(screen.getByLabelText("Close window")).toBeTruthy();
    expect(screen.getByTestId("project-recovery-dock")).toBeTruthy();
    expectButton("Retry");
    expectButton("Export crash report");
    expectButton("Choose another project");
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
    render(AppShellHarness);

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
    expectButton("Choose another project");
    expectButton("Retry opening");
    expectButton("Stop waiting");
    expectButton("Delete local data");

    await fireEvent.click(
      screen.getAllByRole("button", { name: "Stop waiting" })[0]!
    );

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
    render(AppShellHarness);

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
