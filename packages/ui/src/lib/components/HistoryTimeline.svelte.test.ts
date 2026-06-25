import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import type { RequestDefinition } from "@red-request/core/request";

// Mock store + repo so the timeline renders in isolation (no Tauri/sidecar).
const { ws, restoreRequestVersion, requestHistory } = vi.hoisted(() => {
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
    requestHistory: vi.fn(),
  };
});
vi.mock("../store.svelte", () => ({ ws }));
vi.mock("../repo", () => ({ requestHistory }));

import HistoryTimeline from "./HistoryTimeline.svelte";

const req = (name: string, url = "https://x/u"): RequestDefinition =>
  ({ id: "r1", name, method: "GET", url }) as unknown as RequestDefinition;
const commit = (hash: string, message: string, ts: number) => ({
  hash,
  message,
  author: "red-request",
  timestampMs: ts,
  parents: [],
  height: 0,
});

beforeEach(() => vi.clearAllMocks());

describe("HistoryTimeline", () => {
  it("renders versions newest-first, labels the newest 'Current', and shows a diff", async () => {
    // c3 (current) and c1 changed the request; c2 only touched other collections.
    requestHistory.mockResolvedValue([
      {
        commit: commit("h3", "save v2", 3),
        value: req("v2 name"),
        changedHere: true,
      },
      {
        commit: commit("h2", "other edit", 2),
        value: req("v2 name"),
        changedHere: false,
      },
      {
        commit: commit("h1", "create", 1),
        value: req("v1 name"),
        changedHere: true,
      },
    ]);

    render(HistoryTimeline, { onClose: () => {} });

    expect(await screen.findByText("Current")).toBeTruthy();
    // the non-changing commit is shown as context (dim), not a version
    expect(await screen.findByText(/no change to this request/i)).toBeTruthy();
    // newest version selected by default → diff vs the previous version (v1 → v2)
    expect(
      await screen.findByText(/Changes from the previous version/i)
    ).toBeTruthy();
  });

  it("restores a selected past version via the store", async () => {
    requestHistory.mockResolvedValue([
      {
        commit: commit("h2", "save v2", 2),
        value: req("new"),
        changedHere: true,
      },
      {
        commit: commit("h1", "create", 1),
        value: req("old"),
        changedHere: true,
      },
    ]);

    render(HistoryTimeline, { onClose: () => {} });

    const older = await screen.findByText("create");
    await fireEvent.click(older);
    const btn = await screen.findByRole("button", {
      name: /restore this version/i,
    });
    await fireEvent.click(btn);

    expect(restoreRequestVersion).toHaveBeenCalledTimes(1);
    const args = restoreRequestVersion.mock.calls[0] as unknown as [
      RequestDefinition,
    ];
    expect(args[0].name).toBe("old");
  });

  it("shows an empty state when the request has no versions", async () => {
    requestHistory.mockResolvedValue([]);
    render(HistoryTimeline, { onClose: () => {} });
    expect(await screen.findByText(/No saved versions yet/i)).toBeTruthy();
  });
});
