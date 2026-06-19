# 0006 — Embedded RedDB is the live store; YAML is the export artifact

**Status:** accepted · 2026-06-19 · supersedes [ADR-0003](0003-yaml-collections-plus-importers.md)

## Context

ADR-0003 made YAML-on-disk the source of truth. RedDB is this org's own database — having
red-requester persist into an embedded `.rdb` is natural dogfooding and gives a real
runtime store (indexes, scans, queries) instead of ad-hoc file IO. But the Bruno-style
git-friendly, plain-text, diffable workflow is a core value we don't want to lose.

## Decision

**RedDB embedded is the primary store; YAML becomes an export/import artifact.**

- The Rust shell spawns a second sidecar — `red server --http --path <app_data>/app.rdb
--http-bind 127.0.0.1:<port>` (`RED_HTTP_TLS_DEV=1`), readiness via `GET /stats`, reaped
  on exit (mirrors red-ui's `open_embedded`). It exposes the URL via the `reddb_url`
  command.
- Data lives in KV collections: `rr_collections` (key=`<colId>`), `rr_requests`
  (key=`<colId>.<reqId>`), `rr_environments` (key=`<colId>.<env>`). Values are JSON.
- The UI talks to RedDB over local HTTP (CORS `*`); `packages/ui/src/lib/reddb.ts` is the
  only seam. List uses `GET /collections/{c}/scan` (the 0.1.5 list route).
- **Export/Import** (`yaml-io.ts`): write/read a `collection.yaml` + `requests/*.yaml` +
  `environments/*.yaml` tree for git. Export strips secret values.

## Consequences

- Real store with scan/query; dogfoods RedDB; one place for "all content".
- Git workflow preserved via export (not automatic — a deliberate action).
- Adds a second sidecar to spawn/await/reap; if RedDB fails to start the UI shows an error
  instead of silently losing data.
- The shipped `red` binary is **0.1.5** (what red-ui bundles): list is `/scan`, not
  `GET /collections/{c}`; values are strings (we JSON-encode).
