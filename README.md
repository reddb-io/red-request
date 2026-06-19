# red-requester

Open-source, **white-label** API client — a Bruno/Insomnia alternative built on the
[`recker`](https://github.com/forattini-dev/recker) multi-protocol SDK and shipped as a
[Tauri 2](https://tauri.app) desktop app.

- **Offline-first, embedded store** — all content lives in a local **RedDB** `.rdb`
  (an embedded `red server` sidecar). No mandatory cloud, no account. Export to a
  git-friendly **YAML** tree (one request per file) whenever you want to version/share.
- **recker as the dispatcher** — every request is executed by recker, running in a
  bundled sidecar. HTTP today; WebSocket / GraphQL / SSE / gRPC on the roadmap.
- **Secrets stay safe** — secret values are sealed (AES-256-GCM) inside the `.rdb` with a
  master key kept in the OS keychain; YAML export never contains secret values.
- **White-label by design** — product name, identifier, accent color, logo and deep-link
  scheme all come from a single `brand/brand.config.json`. Rebrand without touching code.
- **100% MIT.**

## Architecture

```
Webview (SvelteKit static)
   ⇅  @tauri-apps/api  (invoke + events)
Tauri / Rust  →  fs (collections), keychain (secrets), brand/theming, deep links
   ⇅  stdin/stdout  (NDJSON-RPC, no network port)
Sidecar (@red-requester/engine)  →  recker  →  HTTP / WS / GraphQL / SSE
```

recker is TypeScript and uses raw sockets, so it cannot run inside the webview. It runs
as a **sidecar** the Rust shell spawns and talks to over stdio. See
[`.red/adr/`](.red/adr) for the decisions and [`.red/CONTEXT.md`](.red/CONTEXT.md) for the
glossary.

## Workspace

| Package                  | Role                                                          |
| ------------------------ | ------------------------------------------------------------- |
| `@red-requester/core`    | Shared Zod schemas + variable resolver (UI ⇄ engine contract) |
| `@red-requester/engine`  | Bun/Node sidecar wrapping recker; NDJSON-RPC over stdio       |
| `@red-requester/ui`      | SvelteKit (static) app — the actual client UI                 |
| `@red-requester/desktop` | Tauri 2 shell (Rust)                                          |

## Develop

```bash
pnpm install
pnpm engine:build      # bundle the recker sidecar
pnpm desktop:dev       # launch the desktop app (Tauri)
# or, browser-only UI shell:
pnpm dev
```

## Rebrand (white-label)

Edit `brand/brand.config.json`, drop your logo at the referenced path, then:

```bash
pnpm brand:sync
```

This stamps the Tauri config, the UI theme tokens and the runtime brand constants.

## Roadmap

The first release covers HTTP requests, environments, variable substitution, keychain
secrets and six auth methods. Scripts/tests, WebSocket/GraphQL/SSE/gRPC, importers
(Postman/Insomnia/OpenAPI/.bru/curl/HAR), code generation and a CI runner follow — see
`.red/CONTEXT.md`.
