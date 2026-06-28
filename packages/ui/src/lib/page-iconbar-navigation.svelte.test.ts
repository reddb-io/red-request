import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

vi.mock("./tauri", () => ({ isTauri: true }));
vi.mock("./project", () => ({
  projectInfo: vi.fn(async () => ({
    db_path: "/tmp/fake/app.rdb",
    project_dir: "/tmp/fake",
    is_project: true,
    arg_launched: true,
    name: "fake",
  })),
  openProject: vi.fn(),
  openConnectionString: vi.fn(),
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
  loadUiSettings: vi.fn(async () => ({ redUiEnabled: true })),
  loadEnvironments: vi.fn(async () => []),
  loadAll: vi.fn(async () => []),
  loadHistory: vi.fn(async () => []),
  loadGlobals: vi.fn(async () => null),
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

import { ws } from "./store.svelte";
import AppShellHarness from "./test/AppShellHarness.svelte";

describe("+page icon-bar navigation", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    ws.ready = false;
    ws.bridgeMissing = false;
    ws.loadError = null;
    ws.loading = null;
    ws.closing = false;
    ws.transitioning = false;
    ws.transitionPhase = "idle";
    ws.screen = "selector";
    ws.view = "requests";
    ws.redUiEnabled = false;
    ws.project = null;
    ws.collections = [];
    ws.creatingCollection = false;
    ws.deletingCollectionIds = {};
    ws.deletingProjectData = false;
    ws.activeColId = null;
    ws.activeReq = null;
  });

  it("keeps the left rail icons clickable inside the full app shell", async () => {
    render(AppShellHarness);

    await waitFor(() => expect(ws.screen).toBe("app"));
    await waitFor(() => expect(ws.redUiEnabled).toBe(true));
    await waitFor(() => expect(ws.loading).toBeNull());

    await fireEvent.click(
      screen.getByRole("button", {
        name: "Home: dashboard and network pool",
      })
    );
    await waitFor(() => expect(ws.view).toBe("home"));

    await fireEvent.click(
      screen.getByRole("button", {
        name: "Settings: project configuration",
      })
    );
    await waitFor(() => expect(ws.view).toBe("settings"));
    await waitFor(() =>
      expect(document.body.textContent).toContain("Settings")
    );

    await fireEvent.click(
      screen.getByRole("button", {
        name: "Database: inspect request store",
      })
    );
    await waitFor(() => expect(ws.view).toBe("database"));
    await waitFor(() =>
      expect(document.body.textContent).toContain("Database")
    );

    await fireEvent.click(
      screen.getByRole("button", {
        name: "Requests: collections and workspace",
      })
    );
    await waitFor(() => expect(ws.view).toBe("requests"));
  });
});
