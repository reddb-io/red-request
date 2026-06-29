import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/svelte";
import { newRequest } from "@reddb-io/request-core";
import { ws } from "../store.svelte";
import WebSocketPanel from "./WebSocketPanel.svelte";

describe("WebSocketPanel stream insights", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    ws.activeReq = {
      ...newRequest("req-ws"),
      kind: "ws",
      url: "wss://api.example.test/feed",
    };
    ws.wsStatus = "open";
    ws.wsMessages = [];
  });

  afterEach(() => {
    cleanup();
    ws.activeReq = null;
    ws.wsStatus = "idle";
    ws.wsMessages = [];
  });

  it("renders lifecycle, traffic and close insights from stream messages", () => {
    ws.wsStatus = "closed";
    ws.wsMessages = [
      {
        dir: "sys",
        data: "● connected wss://api.example.test/feed",
        ts: 1,
        sysEvent: "open",
        url: "wss://api.example.test/feed",
      },
      { dir: "out", data: "ping", ts: 2, status: "sent" },
      { dir: "in", data: "pong", ts: 3 },
      {
        dir: "sys",
        data: "● closed 1000 done",
        ts: 4,
        sysEvent: "close",
        closeCode: 1000,
        closeReason: "done",
      },
    ];

    render(WebSocketPanel);

    expect(screen.getByText("WebSocket connected")).toBeTruthy();
    expect(
      screen.getAllByText("wss://api.example.test/feed").length
    ).toBeGreaterThan(0);
    expect(screen.getByText("Frame traffic")).toBeTruthy();
    expect(screen.getByText("1 in / 1 out")).toBeTruthy();
    expect(screen.getByText("Close frame")).toBeTruthy();
    expect(screen.getByText("1000")).toBeTruthy();
  });

  it("renders SSE event type insights", () => {
    ws.activeReq = {
      ...newRequest("req-sse"),
      kind: "sse",
      url: "https://api.example.test/events",
    };
    ws.wsStatus = "open";
    ws.wsMessages = [
      {
        dir: "sys",
        data: "● connected https://api.example.test/events",
        ts: 1,
        sysEvent: "open",
        url: "https://api.example.test/events",
        openStatus: 200,
      },
      {
        dir: "in",
        data: '{"id":1}',
        ts: 2,
        streamEvent: "update",
      },
    ];

    render(WebSocketPanel);

    expect(screen.getByText("SSE connected")).toBeTruthy();
    expect(screen.getByText("200")).toBeTruthy();
    expect(screen.getByText("SSE event types")).toBeTruthy();
    expect(screen.getByText("update")).toBeTruthy();
  });
});
