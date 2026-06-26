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
});
