// WebSocket connections, managed by the engine and streamed to the UI. Each frame is written
// to stdout as `{ stream: {...} }` — the Rust shell re-emits those as `engine://stream` events
// (request/reply RPC can't carry a long-lived stream). Uses the runtime-global WebSocket
// (Node 22 / Bun), typed loosely to avoid pulling in DOM libs.
import {
  resolveRequest,
  type RequestDefinition,
  type VariableScope,
} from "@reddb-io/request-core";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Matches rpcNotificationSchema: { stream: <conn id>, event, data }.
function emit(id: string, event: string, data: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ stream: id, event, data }) + "\n");
}

interface GqlState {
  subscriptionId: string;
  pendingSubscribe: {
    query: string;
    gqlVariables?: Record<string, unknown>;
    operationName?: string;
  } | null;
}

interface PhxState {
  // Monotonic message ref (the Phoenix `ref`, incremented per outbound frame).
  ref: number;
  // topic -> join_ref assigned when that channel was joined.
  joinRefs: Map<string, string>;
  // Periodic keepalive; cleared on close. Capped by a beat deadline.
  heartbeat?: ReturnType<typeof setInterval>;
}

interface ConnState {
  ws: any;
  frameCount: number;
  // null until the first wsSend; incoming frames before any send are unsolicited
  lastFrameId: string | null;
  gql?: GqlState;
  phx?: PhxState;
}
const conns = new Map<string, ConnState>();

export function wsOpen(
  id: string,
  request: RequestDefinition,
  variables: VariableScope
): { ok: boolean } {
  conns.get(id)?.ws?.close?.();
  const { request: resolved } = resolveRequest(request, variables);
  const WS = (globalThis as any).WebSocket;
  if (!WS) throw new Error("WebSocket is not available in this runtime");
  const ws = new WS(resolved.url);
  const state: ConnState = { ws, frameCount: 0, lastFrameId: null };
  conns.set(id, state);
  ws.onopen = () => emit(id, "open", { url: resolved.url });
  ws.onmessage = (e: any) => {
    const isText = typeof e.data === "string";
    const payload: Record<string, unknown> = { dir: "in" };
    if (isText) {
      payload.data = e.data;
    } else {
      payload.data = Buffer.from(e.data).toString("base64");
      payload.isBinary = true;
    }
    // Pair with the last sent frame if there is one; unsolicited frames have no correlationId.
    if (state.lastFrameId !== null) payload.correlationId = state.lastFrameId;
    emit(id, "message", payload);
  };
  ws.onclose = (e: any) => {
    emit(id, "close", { code: e?.code, reason: e?.reason ?? "" });
    conns.delete(id);
  };
  ws.onerror = () => emit(id, "error", { message: "websocket error" });
  return { ok: true };
}

export function wsSend(
  id: string,
  data: string
): { ok: boolean; error?: string } {
  const state = conns.get(id);
  if (!state || state.ws.readyState !== 1) {
    emit(id, "message", { dir: "out", data, status: "error" });
    return { ok: false, error: "not connected" };
  }
  const frameId = `f${++state.frameCount}`;
  state.lastFrameId = frameId;
  try {
    state.ws.send(data);
    emit(id, "message", { dir: "out", data, status: "sent", frameId });
    return { ok: true };
  } catch (e: any) {
    emit(id, "message", { dir: "out", data, status: "error", frameId });
    return { ok: false, error: e?.message ?? "send failed" };
  }
}

export function wsClose(id: string): { ok: boolean } {
  const state = conns.get(id);
  if (state?.phx?.heartbeat) clearInterval(state.phx.heartbeat);
  state?.ws?.close?.();
  conns.delete(id);
  return { ok: true };
}

// --- GraphQL over WebSocket (graphql-transport-ws) -------------------------

export function gqlWsOpen(
  id: string,
  request: RequestDefinition,
  variables: VariableScope,
  query: string,
  gqlVariables?: Record<string, unknown>,
  operationName?: string
): { ok: boolean } {
  conns.get(id)?.ws?.close?.();
  const { request: resolved } = resolveRequest(request, variables);
  const WS = (globalThis as any).WebSocket;
  if (!WS) throw new Error("WebSocket is not available in this runtime");

  const subscriptionId = "sub-1";
  const ws = new WS(resolved.url, ["graphql-transport-ws"]);
  const state: ConnState = {
    ws,
    frameCount: 0,
    lastFrameId: null,
    gql: {
      subscriptionId,
      pendingSubscribe: { query, gqlVariables, operationName },
    },
  };
  conns.set(id, state);

  ws.onopen = () => {
    emit(id, "open", {
      url: resolved.url,
      subprotocol: "graphql-transport-ws",
    });
    const initMsg = JSON.stringify({ type: "connection_init" });
    ws.send(initMsg);
    emit(id, "message", { dir: "out", data: initMsg, status: "sent" });
  };

  ws.onmessage = (e: any) => {
    const raw =
      typeof e.data === "string"
        ? e.data
        : Buffer.from(e.data).toString("utf8");
    emit(id, "message", { dir: "in", data: raw });

    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const gql = state.gql;
    if (!gql) return;

    switch (msg.type) {
      case "connection_ack": {
        const pending = gql.pendingSubscribe;
        if (!pending) break;
        const payload: Record<string, unknown> = { query: pending.query };
        if (pending.gqlVariables) payload.variables = pending.gqlVariables;
        if (pending.operationName)
          payload.operationName = pending.operationName;
        const subscribeMsg = JSON.stringify({
          id: gql.subscriptionId,
          type: "subscribe",
          payload,
        });
        ws.send(subscribeMsg);
        emit(id, "message", { dir: "out", data: subscribeMsg, status: "sent" });
        break;
      }
      case "next":
        emit(id, "gql.next", { subscriptionId: msg.id, payload: msg.payload });
        break;
      case "error":
        emit(id, "error", { subscriptionId: msg.id, errors: msg.payload });
        break;
      case "complete":
        ws.close();
        break;
      case "ping":
        ws.send(JSON.stringify({ type: "pong" }));
        break;
    }
  };

  ws.onclose = (e: any) => {
    emit(id, "close", { code: e?.code, reason: e?.reason ?? "" });
    conns.delete(id);
  };
  ws.onerror = () => emit(id, "error", { message: "websocket error" });

  return { ok: true };
}

export function gqlWsClose(id: string): { ok: boolean } {
  const state = conns.get(id);
  if (state?.gql && state.ws.readyState === 1) {
    state.ws.send(
      JSON.stringify({ id: state.gql.subscriptionId, type: "complete" })
    );
  }
  state?.ws?.close?.();
  conns.delete(id);
  return { ok: true };
}

// --- Phoenix Channels (topic-based rooms over a live ws connection) --------
// Wire format: every frame is a JSON array `[join_ref, ref, topic, event, payload]`.
// The connection is opened with `wsOpen`; `phxJoin`/`phxLeave` then add/remove
// rooms on it and tag every inbound frame with its `room` (the topic) so the UI
// can show which room a message belongs to.

const PHX_HEARTBEAT_MS = 30_000;
// Deadline on the keepalive loop: stop after this many beats so a forgotten
// connection can't drive an unbounded timer.
const PHX_HEARTBEAT_MAX_BEATS = 20;

// Installs the Phoenix-aware inbound handler (and a capped heartbeat) once per
// connection. Inbound frames are parsed as `[join_ref, ref, topic, event, payload]`
// and re-emitted tagged with `room: topic`.
function phxInstall(id: string, state: ConnState): PhxState {
  if (state.phx) return state.phx;
  const phx: PhxState = { ref: 0, joinRefs: new Map() };
  state.phx = phx;
  const ws = state.ws;

  ws.onmessage = (e: any) => {
    const raw =
      typeof e.data === "string"
        ? e.data
        : Buffer.from(e.data).toString("utf8");

    let frame: any;
    try {
      frame = JSON.parse(raw);
    } catch {
      emit(id, "message", { dir: "in", data: raw });
      return;
    }
    if (!Array.isArray(frame)) {
      emit(id, "message", { dir: "in", data: raw });
      return;
    }

    const [, , topic, event, payload] = frame;
    const data: Record<string, unknown> = {
      dir: "in",
      room: topic,
      event,
      data: raw,
    };
    // phx_reply carries the join/leave/push outcome — surface ok/error.
    if (event === "phx_reply" && payload && typeof payload === "object") {
      data.status = (payload as any).status;
      data.response = (payload as any).response;
    }
    emit(id, "message", data);
  };

  // Wrap the existing onclose so the heartbeat is always torn down.
  const prevOnClose = ws.onclose;
  ws.onclose = (ev: any) => {
    if (phx.heartbeat) clearInterval(phx.heartbeat);
    prevOnClose?.(ev);
  };

  let beats = 0;
  phx.heartbeat = setInterval(() => {
    if (ws.readyState !== 1 || beats >= PHX_HEARTBEAT_MAX_BEATS) {
      if (phx.heartbeat) clearInterval(phx.heartbeat);
      return;
    }
    beats++;
    const ref = String(++phx.ref);
    const hb = JSON.stringify([null, ref, "phoenix", "heartbeat", {}]);
    try {
      ws.send(hb);
      emit(id, "message", {
        dir: "out",
        room: "phoenix",
        event: "heartbeat",
        data: hb,
        status: "sent",
      });
    } catch {
      if (phx.heartbeat) clearInterval(phx.heartbeat);
    }
  }, PHX_HEARTBEAT_MS);

  return phx;
}

export function phxJoin(
  id: string,
  topic: string
): { ok: boolean; error?: string } {
  const state = conns.get(id);
  if (!state || state.ws.readyState !== 1) {
    emit(id, "message", {
      dir: "out",
      room: topic,
      event: "phx_join",
      status: "error",
    });
    return { ok: false, error: "not connected" };
  }
  const phx = phxInstall(id, state);
  const ref = String(++phx.ref);
  // join_ref is fixed for the channel's lifetime; reuse this ref for it.
  phx.joinRefs.set(topic, ref);
  const frame = JSON.stringify([ref, ref, topic, "phx_join", {}]);
  try {
    state.ws.send(frame);
    emit(id, "message", {
      dir: "out",
      room: topic,
      event: "phx_join",
      data: frame,
      status: "sent",
    });
    return { ok: true };
  } catch (e: any) {
    emit(id, "message", {
      dir: "out",
      room: topic,
      event: "phx_join",
      data: frame,
      status: "error",
    });
    return { ok: false, error: e?.message ?? "join failed" };
  }
}

export function phxLeave(
  id: string,
  topic: string
): { ok: boolean; error?: string } {
  const state = conns.get(id);
  if (!state || state.ws.readyState !== 1) {
    emit(id, "message", {
      dir: "out",
      room: topic,
      event: "phx_leave",
      status: "error",
    });
    return { ok: false, error: "not connected" };
  }
  const phx = phxInstall(id, state);
  const joinRef = phx.joinRefs.get(topic) ?? null;
  const ref = String(++phx.ref);
  phx.joinRefs.delete(topic);
  const frame = JSON.stringify([joinRef, ref, topic, "phx_leave", {}]);
  try {
    state.ws.send(frame);
    emit(id, "message", {
      dir: "out",
      room: topic,
      event: "phx_leave",
      data: frame,
      status: "sent",
    });
    return { ok: true };
  } catch (e: any) {
    emit(id, "message", {
      dir: "out",
      room: topic,
      event: "phx_leave",
      data: frame,
      status: "error",
    });
    return { ok: false, error: e?.message ?? "leave failed" };
  }
}

// --- server-sent events (kind === "sse") ----------------------------------
const sseAborts = new Map<string, AbortController>();

function parseSseEvent(id: string, chunk: string): void {
  let event = "message";
  const data: string[] = [];
  for (const line of chunk.split("\n")) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:"))
      data.push(line.slice(5).replace(/^ /, ""));
  }
  if (data.length)
    emit(id, "message", { dir: "in", data: data.join("\n"), event });
}

export function sseOpen(
  id: string,
  request: RequestDefinition,
  variables: VariableScope
): { ok: boolean } {
  sseAborts.get(id)?.abort();
  const { request: resolved } = resolveRequest(request, variables);
  const ac = new AbortController();
  sseAborts.set(id, ac);
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  for (const h of resolved.headers)
    if (h.enabled && h.name.trim()) headers[h.name] = h.value;

  void (async () => {
    try {
      const res = await fetch(resolved.url, { headers, signal: ac.signal });
      emit(id, "open", { url: resolved.url, status: res.status });
      if (!res.ok || !res.body) {
        emit(id, "error", {
          message: `HTTP ${res.status} (expected an event stream)`,
        });
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          parseSseEvent(id, buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
      }
      emit(id, "close", {});
    } catch (e: any) {
      if (ac.signal.aborted) emit(id, "close", {});
      else emit(id, "error", { message: e?.message ?? String(e) });
    } finally {
      sseAborts.delete(id);
    }
  })();
  return { ok: true };
}

export function sseClose(id: string): { ok: boolean } {
  sseAborts.get(id)?.abort();
  sseAborts.delete(id);
  return { ok: true };
}
