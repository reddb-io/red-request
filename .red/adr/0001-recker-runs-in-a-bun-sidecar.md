# 0001 — recker runs in a Bun sidecar, not the webview or Rust

**Status:** accepted · 2026-06-19

## Context

The product requirement is that **recker** (`forattini-dev/recker`) is the request
dispatcher. recker is a TypeScript SDK that uses raw sockets (TCP/DNS/WS/FTP/SFTP), HTTP/2,
and AI streaming — none of which work inside a browser/webview. The shell is Tauri 2
(Rust), chosen to match the `red-ui` stack.

So recker can live in exactly one of three places: the webview (impossible), reimplemented
in Rust (violates "recker is the dispatcher"), or a separate JS runtime process.

## Decision

Run recker in a **sidecar process** (`@reddb-io/request-engine`). Production ships it as a
single binary built with `bun build --compile`; in dev it runs as
`node packages/engine/dist/main.js`. The Rust shell spawns and owns it.

## Consequences

- recker runs unchanged, with full socket/streaming capability.
- We carry a JS runtime (~90 MB compiled) — still far lighter than bundling Chromium
  (Electron), and the native shell stays small.
- Two languages in the request path (Rust bridge ↔ JS engine); the contract lives in
  `@reddb-io/request-core` to prevent drift.
- The asdf-global Bun is too old (0.6.14) for `--compile`; the repo pins `bun 1.3.14` in
  `.tool-versions`, and dev falls back to Node (recker runs fine on Node).
