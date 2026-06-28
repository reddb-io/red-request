# 0002 — UI↔engine transport is stdio NDJSON, no network port

**Status:** accepted · 2026-06-19

## Context

The webview must reach the engine. Options: the sidecar opens a localhost HTTP/WS port
(like `red-ui`'s embedded server), or the Rust shell pipes to it over stdio.

## Decision

The Rust shell spawns **one long-lived** engine child and talks to it over **stdin/stdout
as newline-delimited JSON (NDJSON-RPC)**. The webview never talks to the engine directly —
it calls the Rust `engine_call` command, which writes `{id,method,params}` to stdin and
correlates the reply by `id`. Stream messages (no `id`) are re-emitted to the webview as
Tauri events (`engine://stream`).

## Consequences

- **No open port** → nothing on the network to authenticate, scan or collide.
- Rust mediates every call, so it can inject keychain secrets and enforce fs scope.
- We own line framing and id-correlation (small amount of bridge code in `lib.rs`).
- Streaming (SSE/WS/progress, F4) rides the same channel as notifications.

The contract types (`RpcRequest`/`RpcResponse`/`RpcNotification`) live in
`@reddb-io/request-core`.
