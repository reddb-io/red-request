import { describe, expect, it } from "vitest";
import { buildStreamInsights, type StreamLogEntry } from "./streamInsights";

const now = 1_000;

describe("buildStreamInsights", () => {
  it("summarizes websocket lifecycle, traffic and close code", () => {
    const messages: StreamLogEntry[] = [
      {
        dir: "sys",
        data: "● connected wss://api.example.test/feed",
        ts: now,
        sysEvent: "open",
        url: "wss://api.example.test/feed",
      },
      { dir: "out", data: "ping", ts: now + 1, status: "sent" },
      { dir: "in", data: "pong", ts: now + 2 },
      {
        dir: "sys",
        data: "● closed 1000 done",
        ts: now + 3,
        sysEvent: "close",
        closeCode: 1000,
        closeReason: "done",
      },
    ];

    const insights = buildStreamInsights({
      kind: "ws",
      status: "closed",
      messages,
    });

    expect(insights.map((i) => i.title)).toEqual(
      expect.arrayContaining([
        "WebSocket connected",
        "Frame traffic",
        "Close frame",
      ])
    );
    expect(insights.find((i) => i.title === "Frame traffic")).toMatchObject({
      value: "1 in / 1 out",
    });
    expect(insights.find((i) => i.title === "Close frame")).toMatchObject({
      value: "1000",
      tone: "good",
    });
  });

  it("warns when a connected websocket has not received inbound frames", () => {
    const insights = buildStreamInsights({
      kind: "ws",
      status: "open",
      messages: [
        {
          dir: "sys",
          data: "● connected wss://api.example.test/feed",
          ts: now,
          sysEvent: "open",
          url: "wss://api.example.test/feed",
        },
      ],
    });

    expect(
      insights.find((i) => i.title === "No inbound frames yet")
    ).toMatchObject({
      tone: "warn",
    });
  });

  it("surfaces sse event names and HTTP status from the stream handshake", () => {
    const insights = buildStreamInsights({
      kind: "sse",
      status: "open",
      messages: [
        {
          dir: "sys",
          data: "● connected https://api.example.test/events",
          ts: now,
          sysEvent: "open",
          url: "https://api.example.test/events",
          openStatus: 200,
        },
        {
          dir: "in",
          data: '{"id":1}',
          ts: now + 1,
          streamEvent: "update",
        },
      ],
    });

    expect(insights.find((i) => i.title === "SSE connected")).toMatchObject({
      value: "200",
      tone: "good",
    });
    expect(insights.find((i) => i.title === "SSE event types")).toMatchObject({
      detail: "update",
    });
  });

  it("calls out stream errors and outbound send failures", () => {
    const insights = buildStreamInsights({
      kind: "ws",
      status: "error",
      messages: [
        { dir: "out", data: "hello", ts: now, status: "error" },
        {
          dir: "sys",
          data: "● websocket error",
          ts: now + 1,
          sysEvent: "error",
        },
      ],
    });

    expect(insights.find((i) => i.title === "Stream error")).toMatchObject({
      tone: "bad",
    });
    expect(insights.find((i) => i.title === "Send failures")).toMatchObject({
      value: "1",
      tone: "bad",
    });
  });
});
