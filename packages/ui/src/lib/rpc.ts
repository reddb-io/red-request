import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ENGINE_METHODS,
  type HttpSendParams,
  type HttpSendResult,
  type RpcNotification,
  type RunnerParams,
  type RunnerResult,
  type WsOpenParams,
  type WsSendParams,
  type WsCloseParams,
  type CookiesClearParams,
  type GrpcMethodsParams,
  type GrpcMethodsResult,
  type GrpcCallParams,
} from "@red-request/core";

/** Call an engine RPC method through the Rust bridge (stdio NDJSON under the hood). */
export function engineCall<T>(method: string, params: unknown): Promise<T> {
  return invoke<T>("engine_call", { method, params });
}

export function httpSend(params: HttpSendParams): Promise<HttpSendResult> {
  return engineCall<HttpSendResult>(ENGINE_METHODS.httpSend, params);
}

export function runnerRun(params: RunnerParams): Promise<RunnerResult> {
  return engineCall<RunnerResult>(ENGINE_METHODS.runnerRun, params);
}

export function reckerVersion(): Promise<{ version: string }> {
  return engineCall<{ version: string }>(ENGINE_METHODS.metaReckerVersion, {});
}

export function wsOpen(params: WsOpenParams): Promise<{ ok: boolean }> {
  return engineCall(ENGINE_METHODS.wsOpen, params);
}
export function wsSend(
  params: WsSendParams
): Promise<{ ok: boolean; error?: string }> {
  return engineCall(ENGINE_METHODS.wsSend, params);
}
export function wsClose(params: WsCloseParams): Promise<{ ok: boolean }> {
  return engineCall(ENGINE_METHODS.wsClose, params);
}
export function sseOpen(params: WsOpenParams): Promise<{ ok: boolean }> {
  return engineCall(ENGINE_METHODS.sseOpen, params);
}
export function sseClose(params: WsCloseParams): Promise<{ ok: boolean }> {
  return engineCall(ENGINE_METHODS.sseClose, params);
}
export function cookiesClear(
  params: CookiesClearParams
): Promise<{ ok: boolean }> {
  return engineCall(ENGINE_METHODS.cookiesClear, params);
}
export function grpcMethods(
  params: GrpcMethodsParams
): Promise<GrpcMethodsResult> {
  return engineCall(ENGINE_METHODS.grpcMethods, params);
}
export function grpcCall(params: GrpcCallParams): Promise<HttpSendResult> {
  return engineCall(ENGINE_METHODS.grpcCall, params);
}

/** Subscribe to engine stream notifications (SSE/WS/progress) re-emitted by Rust. */
export function onEngineStream(
  cb: (n: RpcNotification) => void
): Promise<UnlistenFn> {
  return listen<RpcNotification>("engine://stream", (e) => cb(e.payload));
}
