import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectionFileSchema,
  newRequest,
  storedEnvironmentSchema,
  type LoadedCollection,
  type RequestDefinition,
} from "@reddb-io/request-core";

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
  deleteCollection: vi.fn(async () => {}),
  saveHistory: vi.fn(async () => {}),
  loadHistory: vi.fn(async () => []),
  nativeMetricDescriptors: vi.fn(async () => []),
  nativeAnalyticsSources: vi.fn(async () => []),
  flushPendingCommit: vi.fn(async () => null),
  ensureStore: vi.fn(async () => {}),
  runMigrations: vi.fn(async () => {}),
  ensureSample: vi.fn(async () => {}),
  loadNetwork: vi.fn(async () => ({ proxies: [], certificates: [] })),
  loadUiSettings: vi.fn(async () => ({ redUiEnabled: false })),
  loadEnvironments: vi.fn(async () => []),
  loadAll: vi.fn(async () => []),
  loadGlobals: vi.fn(async () => null),
  setProjectSyncQueueEnabled: vi.fn(),
  syncConsumerName: vi.fn(async () => "rr_client"),
  currentSyncClientId: vi.fn(async () => "client-1"),
  currentDispatcherIdentity: vi.fn(async () => ({
    clientId: "client-1",
    host: "dev-laptop",
    user: "alice",
  })),
  readSyncEvents: vi.fn(async () => []),
  ackSyncEvent: vi.fn(async () => {}),
}));

vi.mock("./rpc", () => ({
  httpSend: vi.fn(),
  runnerRun: vi.fn(),
  onEngineStream: vi.fn(),
  wsOpen: vi.fn(),
  wsSend: vi.fn(),
  wsClose: vi.fn(),
  sseOpen: vi.fn(),
  sseClose: vi.fn(),
  cookiesClear: vi.fn(async () => {}),
  grpcMethods: vi.fn(),
  grpcCall: vi.fn(),
  proxyProbe: vi.fn(),
  oauth2Token: vi.fn(),
  oidcDiscover: vi.fn(),
  oauthAuthorize: vi.fn(),
}));

vi.mock("./project", () => ({
  projectInfo: vi.fn(),
  openProject: vi.fn(),
  openConnectionString: vi.fn(),
  resetIncompatibleDb: vi.fn(),
  recentSetCount: vi.fn(),
  recentRename: vi.fn(),
  recentRemove: vi.fn(),
  deleteProjectData: vi.fn(),
  projectLabel: vi.fn(() => "project"),
}));

vi.mock("./tauri", () => ({
  isTauri: true,
}));

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

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import * as repo from "./repo";
import * as rpc from "./rpc";
import { ws } from "./store.svelte";

function request(id: string, patch: Partial<RequestDefinition> = {}) {
  return { ...newRequest(id), ...patch };
}

function collection(
  id: string,
  requests: RequestDefinition[],
  folders: string[] = []
): LoadedCollection {
  return {
    id,
    collection: collectionFileSchema.parse({
      name: id,
      order: requests.map((req) => req.id),
      folders,
    }),
    requests,
    environments: [],
  };
}

function resetWorkspace() {
  vi.useRealTimers();
  vi.clearAllMocks();
  (ws as unknown as { stopSyncLoop: () => void }).stopSyncLoop();
  ws.ready = true;
  ws.bridgeMissing = false;
  ws.loadError = null;
  ws.closing = false;
  ws.screen = "selector";
  ws.transitioning = false;
  ws.transitionPhase = "idle";
  ws.loading = null;
  ws.openingTarget = null;
  ws.project = null;
  ws.collections = [];
  ws.creatingCollection = false;
  ws.deletingCollectionIds = {};
  ws.deletingProjectData = false;
  ws.network = { proxies: [], profiles: [] };
  ws.activeColId = null;
  ws.activeReq = null;
  ws.environments = [];
  ws.globals = storedEnvironmentSchema.parse({
    name: "Globals",
    vars: {},
    secrets: {},
  });
  ws.activeEnvName = null;
  vi.mocked(repo.readSyncEvents).mockImplementation(
    () => new Promise<never>(() => {})
  );
}

beforeEach(resetWorkspace);

describe("Workspace persistence coordination", () => {
  it("does not list run history when selecting a request", async () => {
    const refreshHistory = vi
      .spyOn(ws, "refreshReqHistory")
      .mockResolvedValue(undefined);
    ws.collections = [collection("c1", [request("r1"), request("r2")])];
    ws.reqHistory = [
      {
        id: "old-run",
        reqId: "old",
        collectionId: "c1",
        name: "old",
        method: "GET",
        url: "https://example.test",
        ts: 1,
        status: 200,
        ok: true,
        durationMs: 1,
        size: 0,
        testsPassed: 0,
        testsFailed: 0,
      },
    ];

    try {
      ws.selectRequest("c1", "r1");
      ws.selectRequest("c1", "r2");

      expect(refreshHistory).not.toHaveBeenCalled();
      expect(repo.loadHistory).not.toHaveBeenCalled();
      expect(ws.reqHistory).toEqual([]);
    } finally {
      refreshHistory.mockRestore();
    }
  });

  it("flushes the request autosave and VCS checkpoint before switching projects", async () => {
    const { openProject } = await import("./project");
    const calls: string[] = [];
    vi.mocked(repo.saveRequest).mockImplementationOnce(async () => {
      calls.push("save");
    });
    vi.mocked(repo.flushPendingCommit).mockImplementationOnce(async () => {
      calls.push("commit");
      return "c".repeat(64);
    });
    vi.mocked(openProject).mockImplementationOnce(async () => {
      calls.push("open");
      return {
        db_path: "/tmp/new-project/.red/request/app.rdb",
        project_dir: "/tmp/new-project",
        is_project: true,
        arg_launched: false,
        name: "new-project",
      };
    });
    vi.mocked(repo.loadAll).mockResolvedValueOnce([]);

    ws.screen = "app";
    ws.project = {
      db_path: "/tmp/old-project/.red/request/app.rdb",
      project_dir: "/tmp/old-project",
      is_project: true,
      arg_launched: false,
      name: "old-project",
    };
    ws.collections = [collection("c1", [request("r1")])];
    ws.activeColId = "c1";
    ws.activeReq = request("r1", { url: "https://example.test/new" });
    ws.scheduleSave();

    await ws.chooseProject("/tmp/new-project");

    expect(calls).toEqual(["save", "commit", "open"]);
    expect(repo.flushPendingCommit).toHaveBeenCalledTimes(1);
  });

  it("captures a dirty active request before project switch even if autosave has not scheduled yet", async () => {
    const { openProject } = await import("./project");
    const calls: string[] = [];
    vi.mocked(repo.saveRequest).mockImplementationOnce(async (_colId, req) => {
      calls.push(`save:${req.url}`);
    });
    vi.mocked(openProject).mockImplementationOnce(async () => {
      calls.push("open");
      return {
        db_path: "/tmp/new-project/.red/request/app.rdb",
        project_dir: "/tmp/new-project",
        is_project: true,
        arg_launched: false,
        name: "new-project",
      };
    });
    vi.mocked(repo.loadAll).mockResolvedValueOnce([]);

    ws.screen = "app";
    ws.project = {
      db_path: "/tmp/old-project/.red/request/app.rdb",
      project_dir: "/tmp/old-project",
      is_project: true,
      arg_launched: false,
      name: "old-project",
    };
    ws.collections = [collection("c1", [request("r1")])];
    ws.selectRequest("c1", "r1");
    ws.activeReq!.url = "https://example.test/edited-before-effect";

    await ws.chooseProject("/tmp/new-project");

    expect(calls).toEqual([
      "save:https://example.test/edited-before-effect",
      "open",
    ]);
    expect(repo.saveRequest).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        id: "r1",
        url: "https://example.test/edited-before-effect",
      })
    );
    expect(repo.flushPendingCommit).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight autosave before switching projects", async () => {
    vi.useFakeTimers();
    const { openProject } = await import("./project");
    let resolveSave!: () => void;
    vi.mocked(repo.saveRequest).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        })
    );
    vi.mocked(openProject).mockResolvedValueOnce({
      db_path: "/tmp/new-project/.red/request/app.rdb",
      project_dir: "/tmp/new-project",
      is_project: true,
      arg_launched: false,
      name: "new-project",
    });
    vi.mocked(repo.loadAll).mockResolvedValueOnce([]);

    ws.screen = "app";
    ws.project = {
      db_path: "/tmp/old-project/.red/request/app.rdb",
      project_dir: "/tmp/old-project",
      is_project: true,
      arg_launched: false,
      name: "old-project",
    };
    ws.collections = [collection("c1", [request("r1")])];
    ws.activeColId = "c1";
    ws.activeReq = request("r1", { url: "https://example.test/in-flight" });
    ws.scheduleSave();

    await vi.advanceTimersByTimeAsync(300);
    expect(repo.saveRequest).toHaveBeenCalledTimes(1);

    const switching = ws.chooseProject("/tmp/new-project");
    await vi.advanceTimersByTimeAsync(0);

    expect(openProject).not.toHaveBeenCalled();

    resolveSave();
    await switching;

    expect(openProject).toHaveBeenCalledTimes(1);
  });

  it("init exits a stuck project_info call into recovery", async () => {
    vi.useFakeTimers();
    const { projectInfo } = await import("./project");
    vi.mocked(projectInfo).mockImplementationOnce(
      () => new Promise<never>(() => {})
    );
    ws.ready = false;

    const pending = ws.init();
    await vi.advanceTimersByTimeAsync(16_000);
    await pending;

    expect(ws.ready).toBe(true);
    expect(ws.screen).toBe("app");
    expect(ws.loading).toBeNull();
    expect(ws.transitioning).toBe(false);
    expect(ws.loadError).toContain("Startup failed before project info");
    expect(ws.loadError).toContain("timed out");
  });

  it("chooseProject does not wait invisibly forever when the previous project's autosave hangs", async () => {
    vi.useFakeTimers();
    let resolveSave!: () => void;
    vi.mocked(repo.saveRequest).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        })
    );
    ws.screen = "app";
    ws.project = {
      db_path: "/tmp/old-project/.red/request/app.rdb",
      project_dir: "/tmp/old-project",
      is_project: true,
      arg_launched: false,
      name: "old-project",
    };
    ws.collections = [collection("c1", [request("r1")])];
    ws.activeColId = "c1";
    ws.activeReq = request("r1", { url: "https://example.test" });
    ws.scheduleSave();

    const switching = ws.chooseProject("/tmp/new-project");
    await vi.advanceTimersByTimeAsync(0);

    expect(ws.screen).toBe("app");
    expect(ws.loading?.step).toMatch(/saving current project/i);
    expect(ws.openingTarget).toEqual({
      kind: "local",
      dir: "/tmp/new-project",
    });

    await vi.advanceTimersByTimeAsync(6_000);

    expect(ws.loading).toBeNull();
    expect(ws.loadError).toMatch(/saving current project/i);
    expect(ws.recoveryProjectDir).toBe("/tmp/new-project");

    resolveSave();
    await switching;
  });

  it("chooseConnectionString exposes recovery when the previous project's autosave fails", async () => {
    vi.mocked(repo.saveRequest).mockRejectedValueOnce(new Error("disk gone"));
    ws.screen = "app";
    ws.project = {
      db_path: "/tmp/old-project/.red/request/app.rdb",
      project_dir: "/tmp/old-project",
      is_project: true,
      arg_launched: false,
      name: "old-project",
    };
    ws.collections = [collection("c1", [request("r1")])];
    ws.activeColId = "c1";
    ws.activeReq = request("r1", { url: "https://example.test" });
    ws.scheduleSave();

    await ws.chooseConnectionString("wss://team.reddb.io/redwire");

    expect(ws.screen).toBe("app");
    expect(ws.loading).toBeNull();
    expect(ws.loadError).toContain("disk gone");
    expect(ws.openingTarget).toEqual({
      kind: "connection",
      connection: "wss://team.reddb.io/redwire",
    });
    expect(ws.project?.connection_string).toBe("wss://team.reddb.io/redwire");
  });

  it("chooseProject shows recovery immediately and times out a stuck project open", async () => {
    vi.useFakeTimers();
    const { openProject } = await import("./project");
    vi.mocked(openProject).mockImplementationOnce(
      () => new Promise<never>(() => {})
    );

    const pending = ws.chooseProject("/tmp/stuck-project");

    await Promise.resolve();
    expect(ws.transitioning).toBe(false);
    expect(ws.transitionPhase).toBe("idle");
    expect(ws.screen).toBe("app");
    expect(ws.loading?.step).toMatch(/switching/i);

    await vi.advanceTimersByTimeAsync(16_000);
    await pending;

    expect(ws.transitioning).toBe(false);
    expect(ws.transitionPhase).toBe("idle");
    expect(ws.screen).toBe("app");
    expect(ws.loading).toBeNull();
    expect(ws.loadError).toMatch(/timed out/i);
    expect(ws.loadError).toContain("/tmp/stuck-project");
  });

  it("reveals the loading recovery screen immediately while project open is still stuck", async () => {
    vi.useFakeTimers();
    const { openProject } = await import("./project");
    vi.mocked(openProject).mockImplementationOnce(
      () => new Promise<never>(() => {})
    );

    const pending = ws.chooseProject("/tmp/stuck-project");

    await vi.advanceTimersByTimeAsync(0);

    expect(ws.screen).toBe("app");
    expect(ws.loading?.step).toMatch(/switching/i);
    expect(ws.transitioning).toBe(false);
    expect(ws.transitionPhase).toBe("idle");
    expect(ws.loadError).toBeNull();

    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
  });

  it("forceOpenRecovery aborts a stuck project open and preserves the target for retry", async () => {
    vi.useFakeTimers();
    const { openProject } = await import("./project");
    vi.mocked(openProject)
      .mockImplementationOnce(() => new Promise<never>(() => {}))
      .mockResolvedValueOnce({
        db_path: "/tmp/stuck-project/.red/request/app.rdb",
        project_dir: "/tmp/stuck-project",
        is_project: true,
        arg_launched: false,
        name: "stuck-project",
      });

    const stuckOpen = ws.chooseProject("/tmp/stuck-project");
    await vi.advanceTimersByTimeAsync(0);

    ws.forceOpenRecovery("Project opening was stopped after 11s.");

    expect(ws.transitioning).toBe(false);
    expect(ws.transitionPhase).toBe("idle");
    expect(ws.loading).toBeNull();
    expect(ws.loadError).toContain("stopped");
    expect(ws.project?.project_dir).toBe("/tmp/stuck-project");
    expect(ws.openingTarget).toEqual({
      kind: "local",
      dir: "/tmp/stuck-project",
    });

    const retry = ws.retry();
    await vi.advanceTimersByTimeAsync(2_000);
    await retry;

    expect(openProject).toHaveBeenLastCalledWith("/tmp/stuck-project");
    expect(ws.loadError).toBeNull();
    expect(ws.openingTarget).toBeNull();

    await vi.advanceTimersByTimeAsync(16_000);
    await stuckOpen;
    expect(ws.project?.project_dir).toBe("/tmp/stuck-project");
  });

  it("does not let a stale project-open failure overwrite manual recovery", async () => {
    const { openProject } = await import("./project");
    let rejectOpen!: (error: Error) => void;
    vi.mocked(openProject).mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectOpen = reject;
        })
    );

    const stuckOpen = ws.chooseProject("/tmp/stuck-project");
    await vi.waitUntil(() => vi.mocked(openProject).mock.calls.length === 1);

    ws.forceOpenRecovery("Project opening was stopped by the user.");
    expect(ws.loadError).toContain("stopped by the user");

    rejectOpen(new Error("late open failure"));
    await stuckOpen;

    expect(ws.loadError).toContain("stopped by the user");
    expect(ws.loadError).not.toContain("late open failure");
    expect(ws.openingTarget).toEqual({
      kind: "local",
      dir: "/tmp/stuck-project",
    });
  });

  it("does not let a stale connection-string failure overwrite manual recovery", async () => {
    const { openConnectionString } = await import("./project");
    let rejectOpen!: (error: Error) => void;
    vi.mocked(openConnectionString).mockImplementationOnce(
      () =>
        new Promise<never>((_, reject) => {
          rejectOpen = reject;
        })
    );

    const stuckOpen = ws.chooseConnectionString("wss://team.reddb.io/redwire");
    await vi.waitUntil(
      () => vi.mocked(openConnectionString).mock.calls.length === 1
    );

    ws.forceOpenRecovery("Remote project opening was stopped by the user.");
    expect(ws.loadError).toContain("stopped by the user");

    rejectOpen(new Error("late remote open failure"));
    await stuckOpen;

    expect(ws.loadError).toContain("stopped by the user");
    expect(ws.loadError).not.toContain("late remote open failure");
    expect(ws.openingTarget).toEqual({
      kind: "connection",
      connection: "wss://team.reddb.io/redwire",
    });
  });

  it("backToSelector invalidates a stuck load so stale results cannot repopulate the app", async () => {
    let finishNetwork!: (
      value: Awaited<ReturnType<typeof repo.loadNetwork>>
    ) => void;
    vi.mocked(repo.loadNetwork).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishNetwork = resolve;
        })
    );

    const pending = ws.loadStore();
    await vi.waitUntil(
      () => vi.mocked(repo.loadNetwork).mock.calls.length === 1
    );

    ws.backToSelector();
    finishNetwork({
      proxies: [],
      profiles: [
        {
          id: "stale",
          name: "stale",
          userAgent: "",
          headers: [],
          proxyId: "",
          cookieJar: false,
        },
      ],
    });
    await pending;

    expect(ws.screen).toBe("selector");
    expect(ws.network.profiles).toEqual([]);
    expect(ws.loading).toBeNull();
    expect(ws.loadError).toBeNull();
  });

  it("loadStore times out a stuck internal boot step and exposes recovery actions", async () => {
    vi.useFakeTimers();
    vi.mocked(repo.runMigrations).mockImplementationOnce(
      () => new Promise<never>(() => {})
    );

    const pending = ws.loadStore();

    await vi.advanceTimersByTimeAsync(0);
    expect(ws.loading?.step).toBe("running migrations");

    await vi.advanceTimersByTimeAsync(16_000);
    await pending;

    expect(ws.loading).toBeNull();
    expect(ws.loadError).toMatch(/timed out while running migrations/i);
  });

  it("loadStore allows a slow cold database open before exposing recovery", async () => {
    vi.useFakeTimers();
    vi.mocked(repo.ensureStore).mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 20_000))
    );
    let completed = false;

    const pending = ws.loadStore().then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(ws.loading?.step).toBe("opening database file");

    await vi.advanceTimersByTimeAsync(16_000);

    expect(completed).toBe(false);
    expect(ws.loading?.step).toBe("opening database file");
    expect(ws.loadError).toBeNull();

    await vi.advanceTimersByTimeAsync(5_000);
    await pending;

    expect(completed).toBe(true);
    expect(ws.loading).toBeNull();
    expect(ws.loadError).toBeNull();
  });

  it("retry reopens the failed local project instead of only reloading the current store", async () => {
    vi.useFakeTimers();
    const { openProject } = await import("./project");
    ws.screen = "app";
    ws.loadError = "Opening project timed out after 15s: /tmp/stuck-project";
    ws.project = {
      db_path: "/tmp/stuck-project/.red/request/app.rdb",
      project_dir: "/tmp/stuck-project",
      is_project: true,
      arg_launched: false,
      name: "stuck-project",
    };
    vi.mocked(openProject).mockResolvedValueOnce({
      db_path: "/tmp/stuck-project/.red/request/app.rdb",
      project_dir: "/tmp/stuck-project",
      is_project: true,
      arg_launched: false,
      name: "stuck-project",
    });

    const pending = ws.retry();
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;

    expect(openProject).toHaveBeenCalledWith("/tmp/stuck-project");
    expect(repo.runMigrations).toHaveBeenCalled();
    expect(ws.loadError).toBeNull();
    expect(ws.loading).toBeNull();
  });

  it("retry prioritizes the project that was opening over the previously-open project", async () => {
    const { openProject } = await import("./project");
    ws.screen = "app";
    ws.loadError = "Opening project timed out after 15s: /tmp/new-project";
    ws.openingTarget = { kind: "local", dir: "/tmp/new-project" };
    ws.project = {
      db_path: "/tmp/old-project/.red/request/app.rdb",
      project_dir: "/tmp/old-project",
      is_project: true,
      arg_launched: false,
      name: "old-project",
    };
    vi.mocked(openProject).mockResolvedValueOnce({
      db_path: "/tmp/new-project/.red/request/app.rdb",
      project_dir: "/tmp/new-project",
      is_project: true,
      arg_launched: false,
      name: "new-project",
    });

    await ws.retry();

    expect(openProject).toHaveBeenCalledWith("/tmp/new-project");
    expect(openProject).not.toHaveBeenCalledWith("/tmp/old-project");
    expect(ws.project?.project_dir).toBe("/tmp/new-project");
    expect(ws.loadError).toBeNull();
  });

  it("retry reconnects the failed connection-string project source", async () => {
    const { openConnectionString } = await import("./project");
    ws.screen = "app";
    ws.loadError =
      "Connecting to RedDB timed out after 15s: wss://team.reddb.io/redwire";
    ws.project = {
      db_path: "wss://team.reddb.io/redwire",
      project_dir: null,
      is_project: false,
      arg_launched: false,
      source: "remote-http",
      connection_string: "wss://team.reddb.io/redwire",
      name: "Remote RedDB",
    };
    vi.mocked(openConnectionString).mockResolvedValueOnce({
      db_path: "wss://team.reddb.io/redwire",
      project_dir: null,
      is_project: false,
      arg_launched: false,
      source: "remote-http",
      connection_string: "wss://team.reddb.io/redwire",
      name: "Remote RedDB",
    });

    await ws.retry();

    expect(openConnectionString).toHaveBeenCalledWith(
      "wss://team.reddb.io/redwire"
    );
    expect(repo.runMigrations).toHaveBeenCalled();
    expect(ws.loadError).toBeNull();
    expect(ws.loading).toBeNull();
  });

  it("retry prioritizes a failed connection-string open over the stale local project", async () => {
    const { openConnectionString, openProject } = await import("./project");
    ws.screen = "app";
    ws.loadError =
      "Connecting to RedDB timed out after 15s: wss://team.reddb.io/redwire";
    ws.openingTarget = {
      kind: "connection",
      connection: "wss://team.reddb.io/redwire",
    };
    ws.project = {
      db_path: "/tmp/old-project/.red/request/app.rdb",
      project_dir: "/tmp/old-project",
      is_project: true,
      arg_launched: false,
      name: "old-project",
    };
    vi.mocked(openConnectionString).mockResolvedValueOnce({
      db_path: "wss://team.reddb.io/redwire",
      project_dir: null,
      is_project: false,
      arg_launched: false,
      source: "remote-http",
      connection_string: "wss://team.reddb.io/redwire",
      name: "Remote RedDB",
    });

    await ws.retry();

    expect(openConnectionString).toHaveBeenCalledWith(
      "wss://team.reddb.io/redwire"
    );
    expect(openProject).not.toHaveBeenCalled();
    expect(ws.project?.connection_string).toBe("wss://team.reddb.io/redwire");
    expect(ws.loadError).toBeNull();
  });

  it("init does not leave an arg-launched project stuck on the startup loading screen", async () => {
    vi.useFakeTimers();
    const { projectInfo } = await import("./project");
    ws.ready = false;
    vi.mocked(projectInfo).mockResolvedValueOnce({
      db_path: "/tmp/stuck/.red/request/app.rdb",
      project_dir: "/tmp/stuck",
      is_project: true,
      arg_launched: true,
      name: "stuck",
    });
    vi.mocked(repo.runMigrations).mockImplementationOnce(
      () => new Promise<never>(() => {})
    );

    const pending = ws.init().then(() => "resolved");

    await vi.advanceTimersByTimeAsync(0);
    expect(ws.ready).toBe(true);
    expect(ws.screen).toBe("app");
    expect(ws.loading?.step).toBe("running migrations");

    await vi.advanceTimersByTimeAsync(16_000);

    await expect(pending).resolves.toBe("resolved");
    expect(ws.ready).toBe(true);
    expect(ws.screen).toBe("app");
    expect(ws.loading).toBeNull();
    expect(ws.loadError).toMatch(/timed out while running migrations/i);
    expect(ws.openingTarget).toEqual({ kind: "local", dir: "/tmp/stuck" });
  });

  it("ignores stale loadStore results when a newer load starts", async () => {
    let finishStaleNetwork!: (
      value: Awaited<ReturnType<typeof repo.loadNetwork>>
    ) => void;
    const staleNetwork = new Promise<
      Awaited<ReturnType<typeof repo.loadNetwork>>
    >((resolve) => {
      finishStaleNetwork = resolve;
    });
    vi.mocked(repo.loadNetwork)
      .mockImplementationOnce(() => staleNetwork)
      .mockResolvedValueOnce({
        proxies: [],
        profiles: [
          {
            id: "fresh",
            name: "fresh",
            userAgent: "",
            headers: [],
            proxyId: "",
            cookieJar: false,
          },
        ],
      });

    const staleLoad = ws.loadStore();
    await vi.waitUntil(
      () => vi.mocked(repo.loadNetwork).mock.calls.length === 1
    );

    const freshLoad = ws.loadStore();
    await freshLoad;
    expect(ws.network.profiles.map((p) => p.id)).toEqual(["fresh"]);

    finishStaleNetwork({
      proxies: [],
      profiles: [
        {
          id: "stale",
          name: "stale",
          userAgent: "",
          headers: [],
          proxyId: "",
          cookieJar: false,
        },
      ],
    });
    await staleLoad;

    expect(ws.network.profiles.map((p) => p.id)).toEqual(["fresh"]);
    expect(ws.loadError).toBeNull();
  });

  it("clears visible loading when a newer silent reload invalidates it", async () => {
    let finishVisibleNetwork!: (
      value: Awaited<ReturnType<typeof repo.loadNetwork>>
    ) => void;
    vi.mocked(repo.loadNetwork)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishVisibleNetwork = resolve;
          })
      )
      .mockResolvedValueOnce({ proxies: [], profiles: [] });

    const visibleLoad = ws.loadStore();
    await vi.waitUntil(
      () => vi.mocked(repo.loadNetwork).mock.calls.length === 1
    );
    expect(ws.loading?.step).toBe("loading network settings");

    await ws.loadStore(true, { showLoading: false });
    finishVisibleNetwork({ proxies: [], profiles: [] });
    await visibleLoad;

    expect(repo.loadNetwork).toHaveBeenCalledTimes(2);
    expect(ws.loading).toBeNull();
    expect(ws.loadError).toBeNull();
  });

  it("reloads silently when a remote sync event arrives from the project queue", async () => {
    vi.useFakeTimers();
    let readCalls = 0;
    vi.mocked(repo.readSyncEvents).mockImplementation(async () => {
      readCalls++;
      if (readCalls === 1)
        return [
          {
            messageId: "m-remote",
            deliveryId: "did-remote",
            group: "rr_client",
            event: {
              v: 1,
              id: "evt-remote",
              ts: 1,
              source: "red-request",
              clientId: "client-2",
              kind: "request.saved",
              entity: {
                type: "request",
                id: "r2",
                parentId: "c1",
                name: "Remote",
              },
              payload: {},
            },
          },
        ];
      return new Promise<never>(() => {});
    });
    vi.mocked(repo.loadAll)
      .mockResolvedValueOnce([collection("c1", [request("r1")])])
      .mockResolvedValueOnce([collection("c1", [request("r2")])]);

    ws.screen = "app";
    ws.project = {
      db_path: "https://team.reddb.io",
      project_dir: null,
      is_project: false,
      arg_launched: false,
      source: "remote-http",
      connection_string: "https://team.reddb.io",
      name: "Remote RedDB",
    };
    await ws.loadStore();
    expect(ws.collections[0]?.requests.map((req) => req.id)).toEqual(["r1"]);
    expect(repo.setProjectSyncQueueEnabled).toHaveBeenLastCalledWith(true);

    await vi.waitUntil(
      () => vi.mocked(repo.ackSyncEvent).mock.calls.length > 0
    );
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitUntil(() => vi.mocked(repo.loadAll).mock.calls.length >= 2);

    expect(repo.ackSyncEvent).toHaveBeenCalledWith(
      "m-remote",
      "did-remote",
      "rr_client"
    );
    expect(ws.collections[0]?.requests.map((req) => req.id)).toEqual(["r2"]);
    expect(ws.loading).toBeNull();
  });

  it("does not poll the project sync queue for local file projects", async () => {
    vi.useFakeTimers();
    vi.mocked(repo.loadAll).mockResolvedValue([
      collection("c1", [request("r1")]),
    ]);

    ws.screen = "app";
    ws.project = {
      db_path: "/tmp/local-project/.red/request/app.rdb",
      project_dir: "/tmp/local-project",
      is_project: true,
      arg_launched: false,
      source: "local",
      connection_string: null,
      name: "local-project",
    };

    await ws.loadStore();
    await vi.advanceTimersByTimeAsync(300);

    expect(repo.setProjectSyncQueueEnabled).toHaveBeenLastCalledWith(false);
    expect(repo.readSyncEvents).not.toHaveBeenCalled();
    expect(repo.ackSyncEvent).not.toHaveBeenCalled();
    expect(repo.loadAll).toHaveBeenCalledTimes(1);
  });

  it("acks own shared sync events without reloading the project", async () => {
    vi.useFakeTimers();
    let readCalls = 0;
    vi.mocked(repo.readSyncEvents).mockImplementation(async () => {
      readCalls++;
      if (readCalls === 1)
        return [
          {
            messageId: "m-local",
            deliveryId: "did-local",
            group: "rr_client",
            event: {
              v: 1,
              id: "evt-local",
              ts: 1,
              source: "red-request",
              clientId: "client-1",
              kind: "request.saved",
              entity: { type: "request", id: "r1", parentId: "c1" },
              payload: {},
            },
          },
        ];
      return new Promise<never>(() => {});
    });
    vi.mocked(repo.loadAll).mockResolvedValue([
      collection("c1", [request("r1")]),
    ]);

    ws.screen = "app";
    ws.project = {
      db_path: "https://team.reddb.io",
      project_dir: null,
      is_project: false,
      arg_launched: false,
      source: "remote-http",
      connection_string: "https://team.reddb.io",
      name: "Remote RedDB",
    };
    await ws.loadStore();
    await vi.waitUntil(
      () => vi.mocked(repo.ackSyncEvent).mock.calls.length > 0
    );
    await vi.advanceTimersByTimeAsync(300);

    expect(repo.ackSyncEvent).toHaveBeenCalledWith(
      "m-local",
      "did-local",
      "rr_client"
    );
    expect(repo.loadAll).toHaveBeenCalledTimes(1);
  });

  it("chooseConnectionString opens an HTTP RedDB project source and loads the store", async () => {
    const { openConnectionString, openProject } = await import("./project");
    vi.mocked(openConnectionString).mockResolvedValueOnce({
      db_path: "https://team.reddb.io",
      project_dir: null,
      is_project: false,
      arg_launched: false,
      source: "remote-http",
      connection_string: "https://team.reddb.io",
      name: "Remote RedDB",
    });

    await ws.chooseConnectionString("https://team.reddb.io");

    expect(openProject).not.toHaveBeenCalled();
    expect(openConnectionString).toHaveBeenCalledWith("https://team.reddb.io");
    expect(repo.runMigrations).toHaveBeenCalled();
    expect(ws.screen).toBe("app");
    expect(ws.project?.source).toBe("remote-http");
    expect(ws.project?.db_path).toBe("https://team.reddb.io");
    expect(ws.loadError).toBeNull();
  });

  it("chooseConnectionString opens a WebSocket RedDB project source and loads the store", async () => {
    const { openConnectionString, openProject } = await import("./project");
    vi.mocked(openConnectionString).mockResolvedValueOnce({
      db_path: "wss://team.reddb.io/redwire",
      project_dir: null,
      is_project: false,
      arg_launched: false,
      source: "remote-http",
      connection_string: "wss://team.reddb.io/redwire",
      name: "Remote RedDB",
    });

    await ws.chooseConnectionString("wss://team.reddb.io/redwire");

    expect(openProject).not.toHaveBeenCalled();
    expect(openConnectionString).toHaveBeenCalledWith(
      "wss://team.reddb.io/redwire"
    );
    expect(repo.runMigrations).toHaveBeenCalled();
    expect(ws.screen).toBe("app");
    expect(ws.project?.source).toBe("remote-http");
    expect(ws.project?.db_path).toBe("wss://team.reddb.io/redwire");
    expect(ws.loadError).toBeNull();
  });

  it("chooseConnectionString keeps recovery visible when a Docker project source fails", async () => {
    const { openConnectionString, openProject } = await import("./project");
    vi.mocked(openConnectionString).mockRejectedValueOnce(
      new Error(
        "Docker container does not publish 55555/tcp; publish the RedDB HTTP port and retry"
      )
    );

    await ws.chooseConnectionString("docker://reddb:55555");

    expect(openProject).not.toHaveBeenCalled();
    expect(openConnectionString).toHaveBeenCalledWith("docker://reddb:55555");
    expect(ws.screen).toBe("app");
    expect(ws.loading).toBeNull();
    expect(ws.loadError).toContain("does not publish 55555/tcp");
    expect(ws.openingTarget).toEqual({
      kind: "connection",
      connection: "docker://reddb:55555",
    });
    expect(ws.project?.source).toBe("remote-http");
    expect(ws.project?.connection_string).toBe("docker://reddb:55555");
  });

  it("chooseConnectionString clears its timeout after a successful connection", async () => {
    vi.useFakeTimers();
    const { openConnectionString } = await import("./project");
    vi.mocked(openConnectionString).mockResolvedValueOnce({
      db_path: "https://team.reddb.io",
      project_dir: null,
      is_project: false,
      arg_launched: false,
      source: "remote-http",
      connection_string: "https://team.reddb.io",
      name: "Remote RedDB",
    });

    await ws.chooseConnectionString("https://team.reddb.io");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("exportCrashReport writes the current project recovery state to a user-picked JSON file", async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const fs = await import("./fs");
    vi.mocked(save).mockResolvedValueOnce("/tmp/red-request-crash.json");
    vi.mocked(fs.writeTextExternal).mockResolvedValueOnce(undefined);
    ws.project = {
      db_path: "/tmp/fake/.red/request/app.rdb",
      project_dir: "/tmp/fake",
      is_project: true,
      arg_launched: false,
      name: "fake",
    };
    ws.openingTarget = { kind: "local", dir: "/tmp/fake" };
    ws.loadError = "opening project timed out";
    ws.loading = {
      startedAt: 1,
      step: "opening database file",
      log: [{ ts: 1, step: "opening database file" }],
    };

    await ws.exportCrashReport();

    expect(fs.writeTextExternal).toHaveBeenCalledTimes(1);
    const [, contents] = vi.mocked(fs.writeTextExternal).mock.calls[0]!;
    expect(JSON.parse(contents)).toMatchObject({
      kind: "red-request-project-open-crash",
      project: {
        db_path: "/tmp/fake/.red/request/app.rdb",
        project_dir: "/tmp/fake",
      },
      openingTarget: {
        kind: "local",
        dir: "/tmp/fake",
      },
      loadError: "opening project timed out",
      loading: {
        step: "opening database file",
      },
    });
  });

  it("flushes a debounced request save to the original request after fast selection changes", async () => {
    const first = request("r1", { name: "Before" });
    const second = request("r2", { name: "Second" });
    ws.collections = [collection("c1", [first, second])];

    ws.selectRequest("c1", "r1");
    ws.activeReq!.name = "Renamed before click";
    ws.scheduleSave();
    ws.selectRequest("c1", "r2");

    await ws.flushSave();

    expect(repo.saveRequest).toHaveBeenCalledTimes(1);
    expect(repo.saveRequest).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        id: "r1",
        name: "Renamed before click",
      })
    );
    expect(ws.activeReq?.id).toBe("r2");
  });

  it("renames a non-active request by id instead of by current page state", async () => {
    const first = request("r1", { name: "Before" });
    const second = request("r2", { name: "Second" });
    ws.collections = [collection("c1", [first, second])];
    ws.selectRequest("c1", "r2");

    await ws.renameRequest("r1", "Renamed in sidebar");

    expect(repo.saveRequest).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        id: "r1",
        name: "Renamed in sidebar",
      })
    );
    expect(ws.activeReq?.id).toBe("r2");
    expect(ws.activeReq?.name).toBe("Second");
  });

  it("reorders folders in the targeted collection, not only the active collection", async () => {
    ws.collections = [
      collection("c1", [request("r1")], ["root-a"]),
      collection("c2", [request("r2")], ["alpha", "beta", "gamma"]),
    ];
    ws.activeColId = "c1";

    await ws.reorderFolder("gamma", "alpha", "c2");

    expect(ws.collections[1]?.collection.folders).toEqual([
      "gamma",
      "alpha",
      "beta",
    ]);
    expect(repo.saveCollectionMeta).toHaveBeenCalledWith(
      "c2",
      expect.objectContaining({
        folders: ["gamma", "alpha", "beta"],
      })
    );
  });

  it("persists a folder between two root requests", async () => {
    ws.collections = [
      collection(
        "c1",
        [request("r1"), request("r2")],
        ["Folder A", "Folder B"]
      ),
    ];

    await ws.reorderRootItem(
      { kind: "folder", name: "Folder B" },
      { kind: "request", id: "r2" },
      "c1"
    );

    expect(ws.collections[0]?.collection.rootOrder).toEqual([
      { kind: "request", id: "r1" },
      { kind: "folder", name: "Folder B" },
      { kind: "request", id: "r2" },
      { kind: "folder", name: "Folder A" },
    ]);
    expect(repo.saveCollectionMeta).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({
        rootOrder: [
          { kind: "request", id: "r1" },
          { kind: "folder", name: "Folder B" },
          { kind: "request", id: "r2" },
          { kind: "folder", name: "Folder A" },
        ],
      })
    );
  });

  it("moves a request out of a folder at an exact root position", async () => {
    ws.collections = [
      collection(
        "c1",
        [request("r1"), request("nested", { folder: "Folder A" })],
        ["Folder A"]
      ),
    ];

    await ws.reorderRootRequest(
      "nested",
      { kind: "folder", name: "Folder A" },
      "c1"
    );

    expect(ws.collections[0]?.requests[1]?.folder).toBe("");
    expect(ws.collections[0]?.collection.rootOrder).toEqual([
      { kind: "request", id: "r1" },
      { kind: "request", id: "nested" },
      { kind: "folder", name: "Folder A" },
    ]);
  });

  it("removes and restores root entries when a request crosses a folder boundary", async () => {
    ws.collections = [
      collection("c1", [request("r1"), request("r2")], ["Folder A"]),
    ];

    await ws.reorderRequest("r1", "Folder A", null, "c1");
    expect(ws.collections[0]?.collection.rootOrder).toEqual([
      { kind: "request", id: "r2" },
      { kind: "folder", name: "Folder A" },
    ]);

    await ws.reorderRequest("r1", "", null, "c1");
    expect(ws.collections[0]?.collection.rootOrder).toEqual([
      { kind: "request", id: "r2" },
      { kind: "folder", name: "Folder A" },
      { kind: "request", id: "r1" },
    ]);
  });

  it("persists environment tab order through the native config order key", async () => {
    ws.environments = ["dev", "staging", "prod"].map((name) =>
      storedEnvironmentSchema.parse({ name, vars: {}, secrets: {} })
    );

    await ws.reorderEnvironment("prod", "dev");

    expect(ws.environments.map((env) => env.name)).toEqual([
      "prod",
      "dev",
      "staging",
    ]);
    expect(repo.saveEnvironmentOrder).toHaveBeenCalledWith([
      "prod",
      "dev",
      "staging",
    ]);
  });

  it("does not allow an environment rename to collide with another tab", async () => {
    ws.environments = ["dev", "prod"].map((name) =>
      storedEnvironmentSchema.parse({ name, vars: {}, secrets: {} })
    );
    ws.activeEnvName = "dev";

    await ws.renameEnv(ws.environments[0]!, "prod");

    expect(ws.environments.map((env) => env.name)).toEqual(["dev", "prod"]);
    expect(repo.renameEnvironment).not.toHaveBeenCalled();
  });

  it("keeps an environment rename out of live state until persistence succeeds", async () => {
    let finishRename!: () => void;
    vi.mocked(repo.renameEnvironment).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRename = resolve;
        })
    );
    ws.environments = [
      storedEnvironmentSchema.parse({
        name: "dev",
        vars: { API_URL: "https://api.test" },
        secrets: {},
      }),
    ];
    ws.activeEnvName = "dev";

    const pendingRename = ws.renameEnv(ws.environments[0]!, "prod");

    expect(ws.environments[0]!.name).toBe("dev");
    expect(ws.activeEnvName).toBe("dev");

    finishRename();
    await pendingRename;

    expect(repo.renameEnvironment).toHaveBeenCalledWith(
      "dev",
      expect.objectContaining({
        name: "prod",
        vars: { API_URL: "https://api.test" },
      })
    );
    expect(ws.environments[0]!.name).toBe("prod");
    expect(ws.activeEnvName).toBe("prod");
    expect(repo.saveEnvironmentOrder).toHaveBeenCalledWith(["prod"]);
  });

  it("syncProfileHeaders does not throw when no profile is bound", async () => {
    // Repro for the v0.40.1 black-screen: when the request has a profileId
    // that doesn't resolve (deleted profile, fresh project, etc.) the sync
    // helper must be a no-op, not throw. Previously the RequestPanel's
    // `$effect` ran `profile?.headers.map(...)` which crashed with
    // "cannot read properties of undefined" the moment activeReq was set.
    ws.collections = [
      {
        id: "c1",
        collection: collectionFileSchema.parse({
          name: "c1",
          vars: {},
          order: ["r1"],
          folders: [],
          defaultProfileId: "", // no collection default
        }),
        requests: [
          {
            ...request("r1"),
            headers: [],
            profileId: "pf-deleted",
          },
        ],
        environments: [],
      },
    ];
    ws.network = { proxies: [], profiles: [] };
    expect(() => ws.selectRequest("c1", "r1")).not.toThrow();
    expect(ws.activeReq?.headers).toEqual([]);
    expect(ws.loadError).toBeNull();
  });

  it("loading overlay state: emits steps during loadStore so the user sees progress", async () => {
    // Repro for the v0.40.x black-screen-with-no-feedback pattern: if
    // loadStore takes >100ms the user sees *nothing* without an overlay.
    // loadStore now writes `ws.loading.step` at every checkpoint so the
    // "Opening project…" overlay in +page.svelte can show what's happening.
    const { resetIncompatibleDb } = await import("./project");
    vi.mocked(resetIncompatibleDb).mockResolvedValue(undefined);
    vi.mocked(repo.ensureStore).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    vi.mocked(repo.runMigrations).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    vi.mocked(repo.loadNetwork).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { proxies: [], profiles: [] };
    });
    ws.collections = [
      {
        id: "c1",
        collection: collectionFileSchema.parse({
          name: "c1",
          vars: {},
          order: ["r1"],
          folders: [],
        }),
        requests: [{ ...request("r1") }],
        environments: [],
      },
    ];
    ws.network = { proxies: [], profiles: [] };
    ws.loadError = null;

    const inFlight = ws.loadStore();
    // While the load is running, the overlay must be populated.
    expect(ws.loading).toBeTruthy();
    expect(ws.loading?.step).toMatch(
      /starting|database|migrations|network|collections|environments/i
    );
    expect(ws.loading?.log.length).toBeGreaterThan(0);
    await inFlight;
    // After completion, loading is cleared.
    expect(ws.loading).toBeNull();
  });

  it("syncProfileHeaders mirrors the profile into activeReq.headers with fromProfile badge", async () => {
    // Set up a project with one collection, one request, and one profile
    // that injects a UA + custom header. The request has neither.
    const profile = {
      id: "pf-1",
      name: "work",
      userAgent: "red-request/test",
      headers: [{ name: "X-Workspace", value: "engineering", enabled: true }],
      proxyId: "",
      cookieJar: false,
    };
    const colId = "c1";
    const reqId = "r1";
    ws.network.profiles = [profile];
    ws.collections = [
      {
        id: colId,
        collection: collectionFileSchema.parse({
          name: "c1",
          vars: {},
          order: [reqId],
          folders: [],
          defaultProfileId: profile.id,
        }),
        requests: [
          {
            ...request(reqId),
            headers: [],
            profileId: "",
          },
        ],
        environments: [],
      },
    ];
    ws.selectRequest(colId, reqId);

    // selectRequest already calls syncProfileHeaders → UA + X-Workspace should
    // now be in activeReq.headers, each tagged fromProfile: true.
    expect(ws.activeReq?.headers).toContainEqual(
      expect.objectContaining({
        name: "User-Agent",
        value: "red-request/test",
        fromProfile: true,
      })
    );
    expect(ws.activeReq?.headers).toContainEqual(
      expect.objectContaining({
        name: "X-Workspace",
        value: "engineering",
        fromProfile: true,
      })
    );

    // User edits the X-Workspace value → badge clears (now request-local).
    const wsHeader = ws.activeReq!.headers.find(
      (h) => h.name === "X-Workspace"
    );
    wsHeader!.value = "engineering-overridden";
    ws.syncProfileHeaders();
    expect(ws.activeReq!.headers).toContainEqual(
      expect.objectContaining({
        name: "X-Workspace",
        value: "engineering-overridden",
        fromProfile: false,
      })
    );

    // Profile changes its header value → re-sync restores the badge.
    profile.headers = [{ name: "X-Workspace", value: "design", enabled: true }];
    ws.syncProfileHeaders();
    // The user's overridden row stays (still no badge); the profile value
    // did not override a user edit.
    expect(ws.activeReq!.headers).toContainEqual(
      expect.objectContaining({
        name: "X-Workspace",
        value: "engineering-overridden",
        fromProfile: false,
      })
    );

    // A brand-new profile header should land as fromProfile. Replace the whole
    // profiles array so Svelte's $state proxy observes the change.
    ws.network.profiles = [
      {
        ...profile,
        headers: [
          { name: "X-Workspace", value: "design", enabled: true },
          { name: "X-New", value: "1", enabled: true },
        ],
      },
    ];
    ws.syncProfileHeaders();
    expect(ws.activeReq!.headers).toContainEqual(
      expect.objectContaining({
        name: "X-New",
        value: "1",
        fromProfile: true,
      })
    );
  });

  it("sends through the profile proxy when the active profile has one", async () => {
    ws.network = {
      proxies: [
        {
          id: "px-profile",
          name: "Team proxy",
          type: "socks5h",
          host: "proxy.internal",
          port: "1080",
          username: "",
          password: "",
        },
      ],
      profiles: [
        {
          id: "pf-1",
          name: "Team identity",
          userAgent: "",
          headers: [],
          proxyId: "px-profile",
          cookieJar: false,
        },
      ],
    };
    ws.collections = [
      collection("c1", [
        request("r1", {
          method: "GET",
          url: "https://api.example.test/users",
          profileId: "pf-1",
          proxy: "http://manual.local:8080",
        }),
      ]),
    ];
    ws.selectRequest("c1", "r1");
    vi.mocked(rpc.httpSend).mockResolvedValueOnce({
      response: {
        status: 200,
        statusText: "OK",
        ok: true,
        url: "https://api.example.test/users",
        headers: {},
        bodyText: "",
        size: 0,
        durationMs: 12,
      },
      unresolved: [],
      effectiveUrl: "https://api.example.test/users",
    });

    await ws.send();

    expect(ws.activeProfileProxy?.id).toBe("px-profile");
    expect(rpc.httpSend).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          proxy: "socks5h://proxy.internal:1080",
        }),
      })
    );
    expect(ws.renderedRequest?.proxy).toBe("socks5h://proxy.internal:1080");
  });

  it("uses the active profile cookie jar before the collection cookie jar", async () => {
    ws.network = {
      proxies: [],
      profiles: [
        {
          id: "pf-1",
          name: "Team identity",
          userAgent: "",
          headers: [],
          proxyId: "",
          cookieJar: true,
        },
      ],
    };
    ws.collections = [
      {
        ...collection("c1", [
          request("r1", {
            method: "GET",
            url: "https://api.example.test/users",
            profileId: "pf-1",
          }),
        ]),
        collection: collectionFileSchema.parse({
          name: "c1",
          order: ["r1"],
          folders: [],
          cookieJar: true,
        }),
      },
    ];
    ws.selectRequest("c1", "r1");
    vi.mocked(rpc.httpSend).mockResolvedValueOnce({
      response: {
        status: 200,
        statusText: "OK",
        ok: true,
        url: "https://api.example.test/users",
        headers: {},
        bodyText: "",
        size: 0,
        durationMs: 12,
      },
      unresolved: [],
      effectiveUrl: "https://api.example.test/users",
    });

    await ws.send();

    expect(rpc.httpSend).toHaveBeenCalledWith(
      expect.objectContaining({
        cookieJarKey: "profile:pf-1",
      })
    );
  });

  it("clears the active profile cookie jar", async () => {
    ws.network = {
      proxies: [],
      profiles: [
        {
          id: "pf-1",
          name: "Team identity",
          userAgent: "",
          headers: [],
          proxyId: "",
          cookieJar: true,
        },
      ],
    };
    ws.collections = [
      collection("c1", [
        request("r1", {
          profileId: "pf-1",
        }),
      ]),
    ];
    ws.selectRequest("c1", "r1");

    await ws.clearActiveCookies();

    expect(rpc.cookiesClear).toHaveBeenCalledWith({ key: "profile:pf-1" });
  });

  it("records profile, proxy and dispatcher host/user identity in request history", async () => {
    ws.network = {
      proxies: [
        {
          id: "px-profile",
          name: "Team proxy",
          type: "socks5h",
          host: "proxy.internal",
          port: "1080",
          username: "",
          password: "",
        },
      ],
      profiles: [
        {
          id: "pf-1",
          name: "Team identity",
          userAgent: "",
          headers: [],
          proxyId: "px-profile",
          cookieJar: false,
        },
      ],
    };
    ws.collections = [
      collection("c1", [
        request("r1", {
          method: "GET",
          url: "https://api.example.test/users",
          profileId: "pf-1",
        }),
      ]),
    ];
    ws.activeColId = "c1";
    ws.activeEnvName = "Prod";
    ws.selectRequest("c1", "r1");
    vi.mocked(rpc.httpSend).mockResolvedValueOnce({
      response: {
        status: 200,
        statusText: "OK",
        ok: true,
        url: "https://api.example.test/users",
        headers: {},
        bodyText: "",
        size: 0,
        durationMs: 12,
      },
      unresolved: [],
      effectiveUrl: "https://api.example.test/users",
    });

    await ws.send();

    expect(repo.saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        reqId: "r1",
        collectionId: "c1",
        profileId: "pf-1",
        profileName: "Team identity",
        proxyId: "px-profile",
        proxyName: "Team proxy",
        proxyUrl: "socks5h://proxy.internal:1080",
        dispatcherClientId: "client-1",
        dispatcherHost: "dev-laptop",
        dispatcherUser: "alice",
        env: "Prod",
      })
    );
  });

  it("coalesces overlapping collection creation into one persisted collection", async () => {
    let release!: () => void;
    vi.mocked(repo.saveCollectionMeta).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const first = ws.addCollection();
    const second = await ws.addCollection();

    expect(second).toBeNull();
    expect(ws.creatingCollection).toBe(true);
    expect(repo.saveCollectionMeta).toHaveBeenCalledTimes(1);

    release();
    await first;

    expect(ws.creatingCollection).toBe(false);
  });

  it("coalesces overlapping collection deletion for the same collection", async () => {
    let release!: () => void;
    ws.collections = [
      collection("c1", [request("r1")]),
      collection("c2", [request("r2")]),
    ];
    ws.activeColId = "c1";
    vi.mocked(repo.deleteCollection).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const first = ws.deleteCollection("c1");
    await ws.deleteCollection("c1");

    expect(ws.deletingCollectionIds.c1).toBe(true);
    expect(repo.deleteCollection).toHaveBeenCalledTimes(1);

    release();
    await first;

    expect(ws.deletingCollectionIds.c1).toBeUndefined();
    expect(ws.collections.map((c) => c.id)).toEqual(["c2"]);
  });

  it("rebuildStore wipes the on-disk store and reloads without re-healing", async () => {
    const { resetIncompatibleDb } = await import("./project");
    vi.mocked(resetIncompatibleDb).mockResolvedValue(undefined);
    ws.loadError = "model mismatch: …";

    await ws.rebuildStore();

    expect(resetIncompatibleDb).toHaveBeenCalledTimes(1);
    // The wipe clears the previous error: success means loadError is gone.
    expect(ws.loadError).toBeNull();
  });

  it("rebuildStore surfaces a follow-up failure instead of swallowing it", async () => {
    const { resetIncompatibleDb } = await import("./project");
    vi.mocked(resetIncompatibleDb).mockRejectedValue(new Error("disk full"));
    ws.loadError = "model mismatch: …";

    await ws.rebuildStore();

    expect(ws.loadError).toMatch(/Rebuild failed/);
    expect(ws.loadError).toContain("disk full");
  });

  it("backToSelector returns to the project picker without touching data", async () => {
    const { resetIncompatibleDb } = await import("./project");
    ws.screen = "app";
    vi.mocked(resetIncompatibleDb).mockClear();

    ws.backToSelector();

    expect(ws.screen).toBe("selector");
    expect(resetIncompatibleDb).not.toHaveBeenCalled();
  });
});

describe("Workspace saved bodies", () => {
  // Reading through `ws.activeReq` (not a captured ref): assigning a plain object
  // to `$state` wraps it in a reactive proxy, so mutations land on the proxy — the
  // same pattern every other Workspace test in this file follows.
  function activate(patch: Partial<RequestDefinition> = {}) {
    const req = request("r1", patch);
    ws.collections = [collection("c1", [req])];
    ws.activeColId = "c1";
    ws.activeReq = req;
  }

  it("saves the current live body under a name and persists it", async () => {
    activate({
      body: { type: "json", content: '{"a":1}', fields: [] },
    });

    await ws.saveBody("payment.created");

    expect(ws.activeReq!.savedBodies).toHaveLength(1);
    expect(ws.activeReq!.savedBodies[0].name).toBe("payment.created");
    expect(ws.activeReq!.savedBodies[0].body).toEqual({
      type: "json",
      content: '{"a":1}',
      fields: [],
    });
    expect(ws.activeReq!.activeSavedBodyId).toBe(
      ws.activeReq!.savedBodies[0].id
    );
    expect(repo.saveRequest).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ id: "r1" })
    );
  });

  it("applies a saved body into the live body and syncs the Content-Type header", async () => {
    activate({
      body: { type: "none", content: "", fields: [] },
      savedBodies: [
        {
          id: "sb-1",
          name: "json payload",
          body: { type: "json", content: '{"hello":"world"}', fields: [] },
          savedAt: 1,
        },
      ],
    });

    ws.applyBody("sb-1");

    expect(ws.activeReq!.body).toEqual({
      type: "json",
      content: '{"hello":"world"}',
      fields: [],
    });
    expect(ws.activeReq!.activeSavedBodyId).toBe("sb-1");
    expect(
      ws.activeReq!.headers.find((h) => h.name === "Content-Type")?.value
    ).toBe("application/json");
  });

  it("does not mutate the saved body when the live body is edited after applying", async () => {
    activate({
      savedBodies: [
        {
          id: "sb-1",
          name: "orig",
          body: { type: "json", content: '{"n":1}', fields: [] },
          savedAt: 1,
        },
      ],
    });

    ws.applyBody("sb-1");
    ws.activeReq!.body.content = '{"n":999}';

    expect(ws.activeReq!.savedBodies[0].body.content).toBe('{"n":1}');
  });

  it("updates, renames and deletes saved bodies and persists each change", async () => {
    activate({
      body: { type: "json", content: "new content", fields: [] },
      savedBodies: [
        {
          id: "sb-1",
          name: "old",
          body: { type: "json", content: "old content", fields: [] },
          savedAt: 1,
        },
      ],
      activeSavedBodyId: "sb-1",
    });

    await ws.updateBody("sb-1");
    expect(ws.activeReq!.savedBodies[0].body.content).toBe("new content");

    await ws.renameBody("sb-1", "renamed");
    expect(ws.activeReq!.savedBodies[0].name).toBe("renamed");

    await ws.deleteBody("sb-1");
    expect(ws.activeReq!.savedBodies).toHaveLength(0);
    expect(ws.activeReq!.activeSavedBodyId).toBe("");
    expect(repo.saveRequest).toHaveBeenCalledTimes(3);
  });
});
