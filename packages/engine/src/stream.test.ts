import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { wsOpen, wsSend, wsClose, gqlWsOpen, gqlWsClose } from "./stream.js";
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

describe("binary frame handling", () => {
  it("emits isBinary=true and base64-encoded data for binary frames", async () => {
    const binBytes = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
    const wss3 = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => wss3.once("listening", r));
    const port3 = (wss3.address() as AddressInfo).port;
    wss3.on("connection", (sock) => {
      sock.send(binBytes);
    });

    const id = "test-ws-binary";
    const req = {
      ...newRequest(id),
      kind: "ws" as const,
      url: `ws://127.0.0.1:${port3}`,
    };

    const cap = captureStdout();
    wsOpen(id, req, {});

    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("timeout waiting for binary frame")),
        3000
      );
      const poll = setInterval(() => {
        if (
          parseNotifications(cap.lines()).some(
            (m) =>
              m.stream === id &&
              m.event === "message" &&
              (m.data as any).dir === "in" &&
              (m.data as any).isBinary === true
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
    await new Promise<void>((r) => wss3.close(() => r()));

    const msgs = parseNotifications(cap.lines());
    const binaryFrame = msgs.find(
      (m) =>
        m.stream === id &&
        m.event === "message" &&
        (m.data as any).dir === "in" &&
        (m.data as any).isBinary === true
    );
    expect(binaryFrame).toBeDefined();
    const decoded = Buffer.from(
      (binaryFrame!.data as any).data as string,
      "base64"
    );
    expect(decoded).toEqual(binBytes);
  });

  it("does not set isBinary for text frames", async () => {
    const id = "test-ws-text-no-binary-flag";
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

    wsSend(id, "hello text");

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
    const inFrame = msgs.find(
      (m) =>
        m.stream === id && m.event === "message" && (m.data as any).dir === "in"
    );
    expect(inFrame).toBeDefined();
    expect((inFrame!.data as any).isBinary).toBeUndefined();
    expect((inFrame!.data as any).data).toBe("hello text");
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

// ---------------------------------------------------------------------------
// GraphQL over WebSocket (graphql-transport-ws)
// ---------------------------------------------------------------------------

describe("gqlWsOpen — graphql-transport-ws subscription", () => {
  it("streams next payloads and completes", async () => {
    // Stand up a loopback server that speaks graphql-ws:
    //   client connection_init → server connection_ack
    //   client subscribe       → server next × 2 → server complete
    const gqlServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => gqlServer.once("listening", r));
    const gqlPort = (gqlServer.address() as AddressInfo).port;

    gqlServer.on("connection", (sock) => {
      sock.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (msg.type === "connection_init") {
          sock.send(JSON.stringify({ type: "connection_ack" }));
        } else if (msg.type === "subscribe") {
          const subId = msg.id;
          sock.send(
            JSON.stringify({
              id: subId,
              type: "next",
              payload: { data: { count: 1 } },
            })
          );
          sock.send(
            JSON.stringify({
              id: subId,
              type: "next",
              payload: { data: { count: 2 } },
            })
          );
          sock.send(JSON.stringify({ id: subId, type: "complete" }));
        }
      });
    });

    const id = "test-gql-ws-sub";
    const req = {
      ...newRequest(id),
      kind: "ws" as const,
      url: `ws://127.0.0.1:${gqlPort}`,
    };

    const cap = captureStdout();
    gqlWsOpen(id, req, {}, "subscription { count }");

    // Wait for both next payloads to arrive.
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("timeout waiting for gql.next events")),
        3000
      );
      const poll = setInterval(() => {
        const nexts = parseNotifications(cap.lines()).filter(
          (m) => m.stream === id && m.event === "gql.next"
        );
        if (nexts.length >= 2) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });

    cap.stop();
    await new Promise<void>((r) => gqlServer.close(() => r()));

    const msgs = parseNotifications(cap.lines());

    // open event with graphql-transport-ws subprotocol
    const openEvt = msgs.find((m) => m.stream === id && m.event === "open");
    expect(openEvt).toBeDefined();
    expect((openEvt!.data as any).subprotocol).toBe("graphql-transport-ws");

    // connection_init was sent
    const initSent = msgs.find(
      (m) =>
        m.stream === id &&
        m.event === "message" &&
        (m.data as any).dir === "out" &&
        (m.data as any).data?.includes("connection_init")
    );
    expect(initSent).toBeDefined();

    // subscribe was sent after ack
    const subSent = msgs.find(
      (m) =>
        m.stream === id &&
        m.event === "message" &&
        (m.data as any).dir === "out" &&
        (m.data as any).data?.includes('"subscribe"')
    );
    expect(subSent).toBeDefined();

    // two gql.next events with the right payloads
    const nextEvts = msgs.filter(
      (m) => m.stream === id && m.event === "gql.next"
    );
    expect(nextEvts).toHaveLength(2);
    expect((nextEvts[0]!.data as any).payload).toEqual({ data: { count: 1 } });
    expect((nextEvts[1]!.data as any).payload).toEqual({ data: { count: 2 } });
  });

  it("gqlWsClose sends complete and closes the connection", async () => {
    const gqlServer2 = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => gqlServer2.once("listening", r));
    const gqlPort2 = (gqlServer2.address() as AddressInfo).port;

    let gotComplete = false;
    gqlServer2.on("connection", (sock) => {
      sock.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "connection_init") {
          sock.send(JSON.stringify({ type: "connection_ack" }));
        } else if (msg.type === "complete") {
          gotComplete = true;
        }
      });
    });

    const id = "test-gql-ws-close";
    const req = {
      ...newRequest(id),
      kind: "ws" as const,
      url: `ws://127.0.0.1:${gqlPort2}`,
    };

    const cap = captureStdout();
    gqlWsOpen(id, req, {}, "subscription { ping }");

    // Wait for connection_ack (subscribe frame sent after ack)
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("timeout waiting for connection_ack")),
        3000
      );
      const poll = setInterval(() => {
        const msgs = parseNotifications(cap.lines());
        const ackReceived = msgs.some(
          (m) =>
            m.stream === id &&
            m.event === "message" &&
            (m.data as any).dir === "out" &&
            (m.data as any).data?.includes('"subscribe"')
        );
        if (ackReceived) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });

    const result = gqlWsClose(id);
    cap.stop();
    await new Promise<void>((r) => gqlServer2.close(() => r()));

    expect(result.ok).toBe(true);
    expect(gotComplete).toBe(true);
  });

  it("handles ping/pong keepalive", async () => {
    const gqlServer3 = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => gqlServer3.once("listening", r));
    const gqlPort3 = (gqlServer3.address() as AddressInfo).port;

    let gotPong = false;
    gqlServer3.on("connection", (sock) => {
      sock.on("message", (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "connection_init") {
          sock.send(JSON.stringify({ type: "connection_ack" }));
          sock.send(JSON.stringify({ type: "ping" }));
        } else if (msg.type === "pong") {
          gotPong = true;
        }
      });
    });

    const id = "test-gql-ws-ping";
    const req = {
      ...newRequest(id),
      kind: "ws" as const,
      url: `ws://127.0.0.1:${gqlPort3}`,
    };

    const cap = captureStdout();
    gqlWsOpen(id, req, {}, "subscription { noop }");

    // Wait long enough for ping→pong roundtrip
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("timeout waiting for pong")),
        3000
      );
      const poll = setInterval(() => {
        if (gotPong) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });

    cap.stop();
    gqlWsClose(id);
    await new Promise<void>((r) => gqlServer3.close(() => r()));

    expect(gotPong).toBe(true);
  });
});
