import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ENGINE_METHODS,
  type HttpSendParams,
  type HttpSendResult,
  type RpcNotification,
  type RunnerParams,
  type RunnerResult,
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

/** Subscribe to engine stream notifications (SSE/WS/progress) re-emitted by Rust. */
export function onEngineStream(
  cb: (n: RpcNotification) => void
): Promise<UnlistenFn> {
  return listen<RpcNotification>("engine://stream", (e) => cb(e.payload));
}
