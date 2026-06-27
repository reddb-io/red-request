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
  resetIncompatibleDb: vi.fn(),
  recentSetCount: vi.fn(),
  recentRename: vi.fn(),
  recentRemove: vi.fn(),
  deleteProjectData: vi.fn(),
  projectLabel: vi.fn(() => "project"),
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
}

beforeEach(resetWorkspace);

describe("Workspace persistence coordination", () => {
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
