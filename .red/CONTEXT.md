# red-requester — Context

Open-source, white-label API client (a Bruno/Insomnia alternative). Requests are
dispatched by [`recker`](https://github.com/forattini-dev/recker); the app ships as a
Tauri 2 desktop shell. This file is the shared glossary — keep terms consistent across
code, commits and ADRs.

## Language (glossary)

- **Engine** — the `recker` sidecar (`@red-requester/engine`). A standalone process that
  receives a serialized request and returns a serialized response. Never runs in the
  webview (recker uses raw sockets).
- **Sidecar** — the engine as a child process the Rust shell owns. Shipped as a single
  bun-compiled binary; in dev it runs as `node packages/engine/dist/main.js`.
- **Bridge** — the Rust layer between webview and engine: spawns the sidecar, relays
  `engine_call` over stdio, owns the keychain and the collections filesystem.
- **Surface** — a way the UI is presented. Today: the Tauri desktop window. (A browser/PWA
  surface is possible later; that's why `rpc.ts` is the single backend seam.)
- **RedDB store** — the embedded `.rdb` (a `red server` sidecar) that is the **live
  persistence** for all content. KV collections `rr_collections` / `rr_requests` /
  `rr_environments`. The UI talks to it via `reddb.ts`. (ADR-0006.)
- **Collection** — a `CollectionFile` (name, baseUrl, vars, inherited auth, order) stored in
  RedDB under its `colId`.
- **Request** — a `RequestDefinition` (method, url, headers, query, body, auth) stored under
  `colId.reqId`.
- **Environment** — a `StoredEnvironment`: plain `vars` plus `secrets` (sealed values),
  keyed by name.
- **Secret** — a sensitive value **sealed (AES-256-GCM) and stored in the `.rdb`**; the
  master key lives in the OS keychain. The `.rdb` only holds ciphertext. (ADR-0007.)
- **Master key** — the single 256-bit key in the keychain that seals/opens every secret.
- **Variable / `{{name}}`** — placeholder resolved before dispatch. Precedence (high→low):
  secret → environment → collection.
- **Export / Import** — the git-friendly YAML tree (`yaml-io.ts`) written from / read into
  the RedDB store. Export omits secret values. The Bruno-style artifact. (ADR-0006.)
- **Brand** — the white-label identity in `brand/brand.config.json`. `scripts/sync-brand.mjs`
  stamps it into the Tauri config, the theme tokens and the runtime constants.
- **core** — `@red-requester/core`: the Zod schemas + variable resolver shared by the UI and
  the engine. The single source of truth for the wire/disk contract.

## Shape

```
packages/core    schemas + resolver (contract)
packages/engine  recker sidecar (NDJSON-RPC over stdio)
packages/ui      SvelteKit static app (the surface)
apps/desktop     Tauri 2 shell (the bridge)
```

See `.red/adr/` for why each major decision was made.

## Roadmap (post first release)

The first release covers HTTP, environments, variable substitution, keychain secrets and
six auth methods (basic, bearer, apiKey, digest, oauth2, awsSigV4). Next:

- **F2** — full collection/tab/history UI, JSON tree + syntax highlight, cookie jar.
- **F3** — pre-request / post-response scripts (sandbox in the engine) + assertions/tests
  - scoped variables.
- **F4** — WebSocket, GraphQL, SSE, gRPC, upload/download progress (recker already covers
  the protocols; the engine exposes `ws.*` / `sse.*` / `graphql.*` method stubs).
- **F5** — importers/exporters (Postman, Insomnia, OpenAPI, `.bru`, curl, HAR) +
  code generation + a CI runner (`recker/presets` has `curl`/`detectPreset` to lean on).
- **F6** — proxy / mTLS / client certs UI, recker presets as quick-starts, plugins, themes,
  docs site.
