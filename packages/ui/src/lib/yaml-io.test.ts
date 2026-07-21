import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectionFileSchema,
  newRequest,
  type CollectionFile,
  type RequestDefinition,
} from "@reddb-io/request-core";
import { exportAll, importAll } from "./yaml-io";

type DirEntry = { name: string; path: string; is_dir: boolean };

const files = new Map<string, string>();
const dirs = new Set<string>();

vi.mock("./fs", () => ({
  collectionsRoot: vi.fn(async () => "/collections"),
  mkdirp: vi.fn(async (path: string) => {
    dirs.add(path);
  }),
  writeText: vi.fn(async (path: string, text: string) => {
    files.set(path, text);
  }),
  readText: vi.fn(async (path: string) => {
    const text = files.get(path);
    if (text == null) throw new Error(`missing file: ${path}`);
    return text;
  }),
  listDir: vi.fn(async (path: string): Promise<DirEntry[]> => {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const dir of dirs) {
      if (!dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      if (rest && !rest.includes("/")) names.add(rest);
    }
    for (const file of files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (rest && !rest.includes("/")) names.add(rest);
    }
    return [...names].sort().map((name) => {
      const childPath = `${path}/${name}`;
      return {
        name,
        path: childPath,
        is_dir:
          dirs.has(childPath) ||
          [...files.keys()].some((file) => file.startsWith(`${childPath}/`)),
      };
    });
  }),
}));

vi.mock("./repo", () => ({
  slugify: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, "-")),
  resolveEnvironmentSecret: vi.fn(async () => null),
  saveCollectionMeta: vi.fn(async () => {}),
  saveRequest: vi.fn(async () => {}),
  saveEnvironment: vi.fn(async () => {}),
  saveEnvironmentMissingSecret: vi.fn(async () => {}),
}));

import * as repo from "./repo";

beforeEach(() => {
  files.clear();
  dirs.clear();
  vi.clearAllMocks();
});

describe("YAML collection export/import", () => {
  it("round-trips collection default headers", async () => {
    const request = newRequest("r1");
    request.url = "https://api.example.test/users";
    const collection = collectionFileSchema.parse({
      name: "Team API",
      order: ["r1"],
      defaultHeaders: [
        { name: "Authorization", value: "Bearer {{token}}", enabled: true },
        { name: "X-Debug", value: "1", enabled: false },
      ],
    });

    await exportAll([
      {
        id: "team-api",
        collection,
        requests: [request],
        environments: [],
      },
    ]);
    const imported = await importAll();

    expect(imported).toBe(1);
    expect(repo.saveCollectionMeta).toHaveBeenCalledWith(
      "team-api",
      expect.objectContaining<Partial<CollectionFile>>({
        defaultHeaders: collection.defaultHeaders,
      })
    );
    expect(repo.saveRequest).toHaveBeenCalledWith(
      "team-api",
      expect.objectContaining<Partial<RequestDefinition>>({ id: "r1" })
    );
  });

  it("round-trips request disabled inherited headers", async () => {
    const request = newRequest("r1");
    request.url = "https://api.example.test/users";
    request.disabledInheritedHeaders = ["x-team"];
    const collection = collectionFileSchema.parse({
      name: "Team API",
      order: ["r1"],
      defaultHeaders: [{ name: "X-Team", value: "red", enabled: true }],
    });

    await exportAll([
      {
        id: "team-api",
        collection,
        requests: [request],
        environments: [],
      },
    ]);
    const imported = await importAll();

    expect(imported).toBe(1);
    expect(repo.saveRequest).toHaveBeenCalledWith(
      "team-api",
      expect.objectContaining<Partial<RequestDefinition>>({
        id: "r1",
        disabledInheritedHeaders: ["x-team"],
      })
    );
  });
});
