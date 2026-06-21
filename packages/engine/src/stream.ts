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
  if (!ws || ws.readyState !== 1) return { ok: false, error: "not connected" };
  ws.send(data);
  emit(id, "message", { dir: "out", data });
  return { ok: true };
}

export function wsClose(id: string): { ok: boolean } {
  conns.get(id)?.close?.();
  conns.delete(id);
  return { ok: true };
}
