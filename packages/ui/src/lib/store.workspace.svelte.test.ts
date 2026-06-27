import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectionFileSchema,
  newRequest,
  storedEnvironmentSchema,
  type LoadedCollection,
  type RequestDefinition,
} from "@red-request/core";

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
  ensureSample: vi.fn(async () => {}),
  loadNetwork: vi.fn(async () => ({ proxies: [], certificates: [] })),
  loadUiSettings: vi.fn(async () => ({ redUiEnabled: false })),
  loadEnvironments: vi.fn(async () => []),
  loadAll: vi.fn(async () => []),
  loadGlobals: vi.fn(async () => null),
  syncConsumerName: vi.fn(async () => "rr_client"),
  currentSyncClientId: vi.fn(async () => "client-1"),
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
  ws.project = null;
  ws.collections = [];
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
  it("chooseProject times out a stuck project open instead of leaving the black transition mounted forever", async () => {
    vi.useFakeTimers();
    const { openProject } = await import("./project");
    vi.mocked(openProject).mockImplementationOnce(
      () => new Promise<never>(() => {})
    );

    const pending = ws.chooseProject("/tmp/stuck-project");

    await Promise.resolve();
    expect(ws.transitioning).toBe(true);
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

  it("reveals the loading recovery screen while project open is still stuck", async () => {
    vi.useFakeTimers();
    const { openProject } = await import("./project");
    vi.mocked(openProject).mockImplementationOnce(
      () => new Promise<never>(() => {})
    );

    const pending = ws.chooseProject("/tmp/stuck-project");

    await vi.advanceTimersByTimeAsync(1_100);

    expect(ws.screen).toBe("app");
    expect(ws.loading?.step).toMatch(/switching/i);
    expect(ws.transitioning).toBe(false);
    expect(ws.transitionPhase).toBe("idle");
    expect(ws.loadError).toBeNull();

    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
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
        { id: "stale", name: "stale", userAgent: "", headers: [], proxyId: "" },
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

    await vi.advanceTimersByTimeAsync(16_000);

    await expect(pending).resolves.toBe("resolved");
    expect(ws.ready).toBe(true);
    expect(ws.screen).toBe("app");
    expect(ws.loading).toBeNull();
    expect(ws.loadError).toMatch(/timed out while running migrations/i);
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
        { id: "stale", name: "stale", userAgent: "", headers: [], proxyId: "" },
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
    await ws.loadStore();
    expect(ws.collections[0]?.requests.map((req) => req.id)).toEqual(["r1"]);

    await vi.waitUntil(
      () => vi.mocked(repo.ackSyncEvent).mock.calls.length > 0
    );
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitUntil(() => vi.mocked(repo.loadAll).mock.calls.length >= 2);

    expect(repo.ackSyncEvent).toHaveBeenCalledWith("m-remote", "did-remote");
    expect(ws.collections[0]?.requests.map((req) => req.id)).toEqual(["r2"]);
    expect(ws.loading).toBeNull();
  });

  it("acks local sync events without reloading the project", async () => {
    vi.useFakeTimers();
    let readCalls = 0;
    vi.mocked(repo.readSyncEvents).mockImplementation(async () => {
      readCalls++;
      if (readCalls === 1)
        return [
          {
            messageId: "m-local",
            deliveryId: "did-local",
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
    await ws.loadStore();
    await vi.waitUntil(
      () => vi.mocked(repo.ackSyncEvent).mock.calls.length > 0
    );
    await vi.advanceTimersByTimeAsync(300);

    expect(repo.ackSyncEvent).toHaveBeenCalledWith("m-local", "did-local");
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
