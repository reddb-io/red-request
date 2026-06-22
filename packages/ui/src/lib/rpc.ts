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
  type ProxyProbeParams,
  type ProxyProbeResult,
  type Oauth2TokenParams,
  type Oauth2TokenResult,
  type OidcDiscoverParams,
  type OidcDiscoverResult,
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

/** The app's own version (red-request), e.g. "0.1.1". */
export function appVersion(): Promise<string> {
  return invoke<string>("app_version");
}

/** The embedded RedDB version (runs `red --version`), e.g. "1.11.0". */
export function reddbVersion(): Promise<string> {
  return invoke<string>("reddb_version");
}

/** Size + last-modified for a file (e.g. the project's app.rdb). */
export interface FileMeta {
  exists: boolean;
  size: number;
  modifiedMs: number;
}
export function fileMeta(path: string): Promise<FileMeta> {
  return invoke<FileMeta>("file_meta", { path });
}

/** OAuth2 token endpoint (client_credentials / password / authorization_code / refresh). */
export function oauth2Token(
  params: Oauth2TokenParams
): Promise<Oauth2TokenResult> {
  return engineCall<Oauth2TokenResult>(ENGINE_METHODS.oauth2Token, params);
}

/** OIDC discovery — resolve endpoints from an issuer's well-known document. */
export function oidcDiscover(
  params: OidcDiscoverParams
): Promise<OidcDiscoverResult> {
  return engineCall<OidcDiscoverResult>(ENGINE_METHODS.oidcDiscover, params);
}

/** Native interactive authorize step (browser + PKCE + loopback/deep-link callback). */
export interface OauthAuthorizeArgs {
  authorizeUrl: string;
  clientId: string;
  scope?: string;
  audience?: string;
  redirect: "loopback" | "deeplink";
  usePkce: boolean;
  extraParams: { name: string; value: string; enabled: boolean }[];
}
export interface OauthAuthorizeResult {
  code: string;
  codeVerifier?: string;
  redirectUri: string;
  state: string;
}
export function oauthAuthorize(
  args: OauthAuthorizeArgs
): Promise<OauthAuthorizeResult> {
  return invoke<OauthAuthorizeResult>("oauth_authorize", { args });
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

/**
 * Reachability check for a proxy — opens the handshake (TCP / HTTP CONNECT /
 * SocksClient.createConnection) and tears the socket down without forwarding a
 * user request. Powers the per-row "Test" button in the Proxies modal.
 */
export function proxyProbe(
  params: ProxyProbeParams
): Promise<ProxyProbeResult> {
  return engineCall(ENGINE_METHODS.proxyProbe, params);
}

/** Subscribe to engine stream notifications (SSE/WS/progress) re-emitted by Rust. */
export function onEngineStream(
  cb: (n: RpcNotification) => void
): Promise<UnlistenFn> {
  return listen<RpcNotification>("engine://stream", (e) => cb(e.payload));
}
