import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import type { RequestDefinition } from "@red-request/core/request";

// Mock the store + repo so HistoryModal renders in isolation (no real Tauri/sidecar).
// vi.hoisted keeps these definitions above the hoisted vi.mock factories.
const { ws, restoreRequestVersion, listCommits, requestAsOf } = vi.hoisted(
  () => {
    const restoreRequestVersion = vi.fn(async () => {});
    return {
      restoreRequestVersion,
      ws: {
        activeColId: "col1",
        activeReq: {
          id: "r1",
          name: "Get Users",
          method: "GET",
          url: "https://x/u",
        },
        restoreRequestVersion,
      },
      listCommits: vi.fn(),
      requestAsOf: vi.fn(),
    };
  }
);
vi.mock("../store.svelte", () => ({ ws }));
vi.mock("../repo", () => ({ listCommits, requestAsOf }));

import HistoryModal from "./HistoryModal.svelte";

const req = (name: string, url = "https://x/u"): RequestDefinition =>
  ({ id: "r1", name, method: "GET", url }) as unknown as RequestDefinition;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("HistoryModal", () => {
  it("lists distinct versions and labels the newest 'Current'", async () => {
    listCommits.mockResolvedValue([
      { hash: "h3", message: "save v3", timestampMs: 3 },
      { hash: "h2", message: "save v2", timestampMs: 2 },
      { hash: "h1", message: "save v1", timestampMs: 1 },
    ]);
    // h3 and h2 resolve to the same value → collapse into one; h1 differs.
    requestAsOf.mockImplementation(
      async (_c: string, _r: string, hash: string) =>
        hash === "h1" ? req("v1 name") : req("current name")
    );

    render(HistoryModal, { onClose: () => {} });

    // findByText throws if the node never appears, so it is itself the assertion.
    expect(await screen.findByText("Current")).toBeTruthy();
    expect(await screen.findByText("save v1")).toBeTruthy();
    // h3+h2 collapsed → only ONE non-current entry from that value, plus v1.
    expect(screen.queryByText("save v2")).toBeNull();
  });

  it("restores the selected past version via the store", async () => {
    listCommits.mockResolvedValue([
      { hash: "h2", message: "save v2", timestampMs: 2 },
      { hash: "h1", message: "save v1", timestampMs: 1 },
    ]);
    requestAsOf.mockImplementation(
      async (_c: string, _r: string, hash: string) =>
        hash === "h1" ? req("old name") : req("new name")
    );

    render(HistoryModal, { onClose: () => {} });

    // select the older version, then restore
    const older = await screen.findByText("save v1");
    await fireEvent.click(older);
    const restoreBtn = await screen.findByRole("button", {
      name: /restore this version/i,
    });
    await fireEvent.click(restoreBtn);

    expect(restoreRequestVersion).toHaveBeenCalledTimes(1);
    const args = restoreRequestVersion.mock.calls[0] as unknown as [
      RequestDefinition,
    ];
    expect(args[0].name).toBe("old name");
  });

  it("shows an empty state when there is no history", async () => {
    listCommits.mockResolvedValue([]);
    render(HistoryModal, { onClose: () => {} });
    expect(await screen.findByText(/No saved versions yet/i)).toBeTruthy();
  });
});
