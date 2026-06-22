// WebSocket connections, managed by the engine and streamed to the UI. Each frame is written
// to stdout as `{ stream: {...} }` — the Rust shell re-emits those as `engine://stream` events
// (request/reply RPC can't carry a long-lived stream). Uses the runtime-global WebSocket
// (Node 22 / Bun), typed loosely to avoid pulling in DOM libs.
import {
  resolveRequest,
  type RequestDefinition,
  type VariableScope,
} from "@red-request/core";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Matches rpcNotificationSchema: { stream: <conn id>, event, data }.
function emit(id: string, event: string, data: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ stream: id, event, data }) + "\n");
}

const conns = new Map<string, any>();

export function wsOpen(
  id: string,
  request: RequestDefinition,
  variables: VariableScope
): { ok: boolean } {
  conns.get(id)?.close?.();
  const { request: resolved } = resolveRequest(request, variables);
  const WS = (globalThis as any).WebSocket;
  if (!WS) throw new Error("WebSocket is not available in this runtime");
  const ws = new WS(resolved.url);
  conns.set(id, ws);
  ws.onopen = () => emit(id, "open", { url: resolved.url });
  ws.onmessage = (e: any) =>
    emit(id, "message", {
      dir: "in",
      data: typeof e.data === "string" ? e.data : "[binary frame]",
    });
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
  const ws = conns.get(id);
  if (!ws || ws.readyState !== 1) {
    emit(id, "message", { dir: "out", data, status: "error" });
    return { ok: false, error: "not connected" };
  }
  try {
    ws.send(data);
    emit(id, "message", { dir: "out", data, status: "sent" });
    return { ok: true };
  } catch (e: any) {
    emit(id, "message", { dir: "out", data, status: "error" });
    return { ok: false, error: e?.message ?? "send failed" };
  }
}

export function wsClose(id: string): { ok: boolean } {
  conns.get(id)?.close?.();
  conns.delete(id);
  return { ok: true };
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
