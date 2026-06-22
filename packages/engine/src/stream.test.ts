import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { wsOpen, wsSend, wsClose } from "./stream.js";
import { newRequest } from "@red-request/core";

let wss: WebSocketServer;
let wsPort = 0;

// Intercept process.stdout.write to capture engine NDJSON notifications.
// Does NOT forward to actual stdout to avoid recursive calls through
// Node.js's internal stream machinery.
function captureStdout(): { lines: () => string[]; stop: () => void } {
  const written: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  return {
    lines: () =>
      written
        .join("")
        .split("\n")
        .filter((l) => l.trim()),
    stop: () => spy.mockRestore(),
  };
}

function parseNotifications(lines: string[]): Array<{
  stream: string;
  event: string;
  data: Record<string, unknown>;
}> {
  return lines.map((l) => JSON.parse(l));
}

beforeAll(async () => {
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => wss.once("listening", r));
  wsPort = (wss.address() as AddressInfo).port;

  // Echo server: send back whatever it receives.
  wss.on("connection", (sock) => {
    sock.on("message", (msg) => sock.send(msg.toString()));
  });

  // Node 22 ships WebSocket natively; the ws package also exports it.
  const wsModule = await import("ws");
  (globalThis as any).WebSocket = wsModule.WebSocket;
});

afterAll(async () => {
  await new Promise<void>((r) => wss.close(() => r()));
  delete (globalThis as any).WebSocket;
});

describe("wsOpen + wsSend notifications", () => {
  it("emits status=sent on a successful send", async () => {
    const id = "test-ws-send-ok";
    const req = {
      ...newRequest(id),
      kind: "ws" as const,
      url: `ws://127.0.0.1:${wsPort}`,
    };

    const cap = captureStdout();
    wsOpen(id, req, {});

    // Wait for the engine to emit the "open" notification.
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("timeout waiting for open")),
        3000
      );
      const poll = setInterval(() => {
        const msgs = parseNotifications(cap.lines());
        if (msgs.some((m) => m.stream === id && m.event === "open")) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });

    const result = wsSend(id, "hello");
    cap.stop();

    expect(result.ok).toBe(true);

    const msgs = parseNotifications(cap.lines());
    const outFrame = msgs.find(
      (m) =>
        m.stream === id &&
        m.event === "message" &&
        (m.data as any).dir === "out"
    );
    expect(outFrame).toBeDefined();
    expect((outFrame!.data as any).status).toBe("sent");
    expect((outFrame!.data as any).data).toBe("hello");

    wsClose(id);
  });

  it("replays a frame by re-sending its exact payload", async () => {
    const id = "test-ws-replay";
    const req = {
      ...newRequest(id),
      kind: "ws" as const,
      url: `ws://127.0.0.1:${wsPort}`,
    };

    const cap = captureStdout();
    wsOpen(id, req, {});

    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("timeout waiting for open")),
        3000
      );
      const poll = setInterval(() => {
        if (
          parseNotifications(cap.lines()).some(
            (m) => m.stream === id && m.event === "open"
          )
        ) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });

    const payload = '{"type":"ping"}';
    wsSend(id, payload);
    wsSend(id, payload); // replay: same payload re-sent
    cap.stop();

    const outFrames = parseNotifications(cap.lines()).filter(
      (m) =>
        m.stream === id &&
        m.event === "message" &&
        (m.data as any).dir === "out" &&
        (m.data as any).data === payload
    );
    expect(outFrames).toHaveLength(2);
    expect(outFrames.every((f) => (f.data as any).status === "sent")).toBe(
      true
    );

    wsClose(id);
  });

  it("emits status=error when not connected", () => {
    const id = "test-ws-disconnected";

    const cap = captureStdout();
    const result = wsSend(id, "wont-send");
    cap.stop();

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();

    const msgs = parseNotifications(cap.lines());
    const outFrame = msgs.find(
      (m) =>
        m.stream === id &&
        m.event === "message" &&
        (m.data as any).dir === "out"
    );
    expect(outFrame).toBeDefined();
    expect((outFrame!.data as any).status).toBe("error");
  });
});

describe("wsOpen frame correlation", () => {
  it("tags sent frames with frameId and echoed replies with correlationId", async () => {
    const id = "test-ws-corr-ok";
    const req = {
      ...newRequest(id),
      kind: "ws" as const,
      url: `ws://127.0.0.1:${wsPort}`,
    };

    const cap = captureStdout();
    wsOpen(id, req, {});

    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("timeout waiting for open")),
        3000
      );
      const poll = setInterval(() => {
        if (
          parseNotifications(cap.lines()).some(
            (m) => m.stream === id && m.event === "open"
          )
        ) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });

    wsSend(id, "ping");

    // Wait for the echo (dir=in) to arrive.
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("timeout waiting for echo")),
        3000
      );
      const poll = setInterval(() => {
        if (
          parseNotifications(cap.lines()).some(
            (m) =>
              m.stream === id &&
              m.event === "message" &&
              (m.data as any).dir === "in"
          )
        ) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });

    cap.stop();
    wsClose(id);

    const msgs = parseNotifications(cap.lines());
    const sent = msgs.find(
      (m) =>
        m.stream === id &&
        m.event === "message" &&
        (m.data as any).dir === "out"
    );
    const received = msgs.find(
      (m) =>
        m.stream === id && m.event === "message" && (m.data as any).dir === "in"
    );

    expect(sent).toBeDefined();
    expect((sent!.data as any).frameId).toBe("f1");

    expect(received).toBeDefined();
    expect((received!.data as any).correlationId).toBe("f1");
  });

  it("leaves unsolicited server-initiated frames without correlationId", async () => {
    // A server that pushes a welcome frame immediately on connect (before the client sends).
    const wss2 = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => wss2.once("listening", r));
    const port2 = (wss2.address() as AddressInfo).port;
    wss2.on("connection", (sock) => {
      sock.send("welcome");
    });

    const id = "test-ws-corr-unsolicited";
    const req = {
      ...newRequest(id),
      kind: "ws" as const,
      url: `ws://127.0.0.1:${port2}`,
    };

    const cap = captureStdout();
    wsOpen(id, req, {});

    // Wait for the welcome frame (dir=in).
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("timeout waiting for welcome")),
        3000
      );
      const poll = setInterval(() => {
        if (
          parseNotifications(cap.lines()).some(
            (m) =>
              m.stream === id &&
              m.event === "message" &&
              (m.data as any).dir === "in"
          )
        ) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });

    cap.stop();
    wsClose(id);
    await new Promise<void>((r) => wss2.close(() => r()));

    const msgs = parseNotifications(cap.lines());
    const welcome = msgs.find(
      (m) =>
        m.stream === id && m.event === "message" && (m.data as any).dir === "in"
    );
    expect(welcome).toBeDefined();
    expect((welcome!.data as any).correlationId).toBeUndefined();
  });
});
