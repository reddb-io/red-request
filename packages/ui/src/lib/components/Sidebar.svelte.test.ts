import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/svelte";
import { collectionFileSchema, newRequest } from "@reddb-io/request-core";

import { ws } from "../store.svelte";
import SidebarHarness from "../test/SidebarHarness.svelte";

vi.mock("../repo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repo")>()),
  saveCollectionMeta: vi.fn().mockResolvedValue(undefined),
  saveRequest: vi.fn().mockResolvedValue(undefined),
}));

describe("Sidebar inline rename gestures", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const req = {
      ...newRequest("req-1"),
      name: "List users",
      method: "GET" as const,
      url: "https://api.example.test/users",
    };
    ws.project = null;
    ws.collections = [
      {
        id: "col-1",
        collection: {
          name: "Team API",
          order: ["req-1"],
          folders: [],
          rootOrder: [],
          vars: {},
          auth: { type: "none" },
          cookieJar: false,
          defaultProfileId: "",
          defaultHeaders: [],
        },
        requests: [req],
        environments: [],
      },
    ];
    ws.activeColId = "col-1";
    ws.activeReq = req;
    ws.network = { proxies: [], profiles: [] };
    ws.view = "requests";
    ws.scopeConfigTarget = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("renames a request after double-clicking its name", async () => {
    const renameRequest = vi.spyOn(ws, "renameRequest").mockResolvedValue();

    render(SidebarHarness);

    await fireEvent.dblClick(screen.getByText("List users"));
    const input = await screen.findByDisplayValue("List users");
    await fireEvent.input(input, { target: { value: "Fetch users" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(renameRequest).toHaveBeenCalledWith("req-1", "Fetch users");
    });
  });

  it("renames a collection after double-clicking its name", async () => {
    const renameCollection = vi
      .spyOn(ws, "renameCollection")
      .mockResolvedValue();

    render(SidebarHarness);

    await fireEvent.dblClick(screen.getByText("Team API"));
    const input = await screen.findByDisplayValue("Team API");
    await fireEvent.input(input, { target: { value: "Platform API" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(renameCollection).toHaveBeenCalledWith("col-1", "Platform API");
    });
  });

  it("opens collection and folder config from sidebar actions", async () => {
    const folderReq = {
      ...newRequest("req-2"),
      name: "Folder request",
      folder: "Admin",
    };
    ws.collections[0]!.collection = collectionFileSchema.parse({
      ...ws.collections[0]!.collection,
      folders: ["Admin"],
      order: ["req-1", "req-2"],
      rootOrder: [
        { kind: "request", id: "req-1" },
        { kind: "folder", name: "Admin" },
      ],
    });
    ws.collections[0]!.requests.push(folderReq);
    const openScopeConfig = vi
      .spyOn(ws, "openScopeConfig")
      .mockImplementation(() => {});

    render(SidebarHarness);

    await fireEvent.click(screen.getByLabelText("configure Team API"));
    expect(openScopeConfig).toHaveBeenCalledWith({
      kind: "collection",
      colId: "col-1",
    });

    await fireEvent.click(screen.getByLabelText("configure Admin"));
    expect(openScopeConfig).toHaveBeenCalledWith({
      kind: "folder",
      colId: "col-1",
      folder: "Admin",
    });
  });

  it("keeps collection and folder name clicks as expand/collapse toggles", async () => {
    const folderReq = {
      ...newRequest("req-2"),
      name: "Folder request",
      folder: "Admin",
    };
    ws.collections[0]!.collection = collectionFileSchema.parse({
      ...ws.collections[0]!.collection,
      folders: ["Admin"],
      order: ["req-1", "req-2"],
      rootOrder: [
        { kind: "request", id: "req-1" },
        { kind: "folder", name: "Admin" },
      ],
    });
    ws.collections[0]!.requests.push(folderReq);
    const openScopeConfig = vi.spyOn(ws, "openScopeConfig");

    render(SidebarHarness);

    await fireEvent.click(screen.getByText("Admin"));
    expect(screen.queryByText("Folder request")).toBeNull();
    expect(openScopeConfig).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByText("Team API"));
    expect(screen.queryByText("List users")).toBeNull();
    expect(openScopeConfig).not.toHaveBeenCalled();
  });
});

describe("Sidebar root drag-and-drop", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const rootOne = {
      ...newRequest("root-1"),
      name: "Root one",
    };
    const rootTwo = {
      ...newRequest("root-2"),
      name: "Root two",
    };
    ws.project = null;
    ws.collections = [
      {
        id: "col-1",
        collection: collectionFileSchema.parse({
          name: "Mixed tree",
          order: ["root-1", "root-2"],
          folders: ["Folder A", "Folder B"],
          rootOrder: [],
          vars: {},
          auth: { type: "none" },
          cookieJar: false,
          defaultProfileId: "",
          defaultHeaders: [],
        }),
        requests: [rootOne, rootTwo],
        environments: [],
      },
    ];
    ws.activeColId = "col-1";
    ws.activeReq = rootOne;
    ws.network = { proxies: [], profiles: [] };
    ws.view = "requests";
    ws.scopeConfigTarget = null;
  });

  afterEach(() => {
    cleanup();
  });

  function button(label: string): HTMLButtonElement {
    const element = screen.getByText(label).closest("button");
    if (!(element instanceof HTMLButtonElement))
      throw new Error(`button not found for ${label}`);
    return element;
  }

  function requestRow(label: string): HTMLElement {
    const row = button(label).parentElement;
    if (!row) throw new Error(`request row not found for ${label}`);
    return row;
  }

  function appearsBefore(left: string, right: string): boolean {
    return !!(
      screen.getByText(left).compareDocumentPosition(screen.getByText(right)) &
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  }

  async function dragFolderOntoRequest(
    folder: string,
    request: string,
    clientY: number
  ): Promise<void> {
    const target = requestRow(request);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 100,
      bottom: 20,
      width: 100,
      height: 20,
      toJSON: () => ({}),
    });
    const dataTransfer = {
      setData: vi.fn(),
      effectAllowed: "none",
      dropEffect: "none",
    };
    const dragEvent = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        clientY: { value: clientY },
        dataTransfer: { value: dataTransfer },
      });
      return event;
    };

    await fireEvent(button(folder), dragEvent("dragstart"));
    await fireEvent(target, dragEvent("dragover"));
    await fireEvent(target, dragEvent("drop"));
  }

  it("renders a persisted folder between root requests", () => {
    ws.collections[0]!.collection.rootOrder = [
      { kind: "request", id: "root-1" },
      { kind: "folder", name: "Folder B" },
      { kind: "request", id: "root-2" },
      { kind: "folder", name: "Folder A" },
    ];
    render(SidebarHarness);

    expect(appearsBefore("Root one", "Folder B")).toBe(true);
    expect(appearsBefore("Folder B", "Root two")).toBe(true);
  });

  it("targets the position before a root request when a folder is dropped on its top half", async () => {
    const reorderRootItem = vi
      .spyOn(ws, "reorderRootItem")
      .mockResolvedValue(undefined);
    render(SidebarHarness);

    await dragFolderOntoRequest("Folder B", "Root one", 1);

    expect(reorderRootItem).toHaveBeenCalledWith(
      { kind: "folder", name: "Folder B" },
      { kind: "request", id: "root-1" },
      "col-1"
    );
  });

  it("targets the next root sibling when a folder is dropped on a request's bottom half", async () => {
    const reorderRootItem = vi
      .spyOn(ws, "reorderRootItem")
      .mockResolvedValue(undefined);
    render(SidebarHarness);

    await dragFolderOntoRequest("Folder B", "Root one", 19);

    expect(reorderRootItem).toHaveBeenCalledWith(
      { kind: "folder", name: "Folder B" },
      { kind: "request", id: "root-2" },
      "col-1"
    );
    expect(ws.collections[0]?.requests[0]?.folder).toBe("");
  });
});
