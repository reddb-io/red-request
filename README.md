<div align="center">

<img src="brand/assets/logo.svg" alt="Red Request" width="96" height="96" />

# Red Request

**The open-source, white-label API client.** A Bruno/Insomnia alternative that dispatches
through the [`recker`](https://github.com/forattini-dev/recker) multi-protocol SDK and ships
as a fast [Tauri 2](https://tauri.app) desktop app.

<p>
  <a href="https://github.com/reddb-io/red-request/releases"><img src="https://img.shields.io/github/v/release/reddb-io/red-request?style=flat-square&color=ff2056" alt="Release"></a>
  <a href="https://github.com/reddb-io/red-request/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/reddb-io/red-request/ci.yml?branch=main&style=flat-square&label=CI" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-linux%20·%20macOS%20·%20windows-555?style=flat-square" alt="Platforms">
  <img src="https://img.shields.io/badge/built%20with-Tauri%202%20·%20Svelte%205-555?style=flat-square" alt="Stack">
</p>

</div>

---

## Install

**Linux** — one line, no account, no telemetry:

```bash
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-request/main/install.sh | bash
```

**Everywhere** — grab the installer for your platform from the
[**latest release**](https://github.com/reddb-io/red-request/releases/latest):

| Platform            | Asset                      |
| ------------------- | -------------------------- |
| Linux               | `.AppImage` · `.deb`       |
| macOS (Apple/Intel) | `.dmg` (`aarch64` / `x64`) |
| Windows             | `.msi` · NSIS `-setup.exe` |

> Builds are unsigned for now — macOS: right-click → **Open**; Windows: **More info → Run anyway**.
> Uninstall on Linux with `curl -fsSL https://raw.githubusercontent.com/reddb-io/red-request/main/uninstall.sh | bash`.

---

## Why Red Request

- ⚡ **Native & fast** — a Tauri shell (Rust) around a SvelteKit UI. No Electron tax.
- 🔌 **Multi-protocol by design** — every request runs through **recker**. HTTP today;
  TCP, UDP, ping, WHOIS and DNS already shipped as first-class request _kinds_;
  WebSocket / GraphQL / SSE / gRPC on the roadmap.
- 💾 **Offline-first, embedded store** — content lives in a local **RedDB** `.rdb`
  (an embedded `red` sidecar). No mandatory cloud, no sign-in.
- 🌿 **Git-friendly** — export collections to a **YAML** tree (one request per file) to
  version and review in PRs. Secrets are never exported.
- 🔐 **Secrets stay safe** — sealed with **AES-256-GCM**, master key in the OS keychain.
- 🎨 **Truly white-label** — product name, identifier, accent, logo and deep-link scheme
  all come from a single `brand/brand.config.json`. Rebrand without touching code.
- 🧩 **Built-ins** — command palette (`⌘K`), a runner (repeat / data-driven / flow), request
  reordering, and native SQL migrations via RedDB.
- 🆓 **100% MIT.**

---

## Architecture

```
Webview (SvelteKit static, Svelte 5 + shadcn-svelte)
   ⇅  @tauri-apps/api  (invoke + events)
Tauri / Rust  →  fs, OS keychain (secrets), brand/theming, deep links
   ├─ stdin/stdout (NDJSON-RPC)  →  Sidecar (@red-request/engine) → recker → HTTP / TCP / UDP / DNS / …
   └─ HTTP 127.0.0.1             →  Sidecar (RedDB `red`)         → embedded .rdb store
```

recker is TypeScript and uses raw sockets, so it can't run inside the webview — it runs as
a **sidecar** the Rust shell spawns and talks to over stdio. RedDB is a second sidecar
serving the local store. See [`.red/adr/`](.red/adr) for the decisions and
[`.red/CONTEXT.md`](.red/CONTEXT.md) for the glossary.

| Package                | Role                                                          |
| ---------------------- | ------------------------------------------------------------- |
| `@red-request/core`    | Shared Zod schemas + variable resolver (UI ⇄ engine contract) |
| `@red-request/engine`  | Bun/Node sidecar wrapping recker; NDJSON-RPC over stdio       |
| `@red-request/ui`      | SvelteKit (static) app — the client UI                        |
| `@red-request/desktop` | Tauri 2 shell (Rust)                                          |

---

## Develop

```bash
pnpm install
pnpm reddb:fetch       # download the RedDB sidecar from its releases (or pnpm reddb:sync to build from ../reddb)
pnpm desktop:dev       # launch the desktop app (Tauri) with hot reload
# or just the browser UI shell:  pnpm dev
```

Tooling: **pnpm** workspace, **Bun** for the compiled engine sidecar, **Rust** for the Tauri
shell. `pnpm check` (typecheck) · `pnpm test` · `pnpm build`.

### Projects (`rr .`)

A folder becomes a project when you open the app pointed at it — its data lives in
`<folder>/.red/request/app.rdb`, which you can commit. With no folder, the app uses the
global `~/.red/request/app.rdb`.

```bash
pnpm desktop:build              # build the app once
ln -s "$PWD/scripts/rr" ~/.local/bin/rr
rr .                            # open the project rooted here
rr ~/work/my-api                # …or another folder
rr                              # global store
```

---

## Rebrand (white-label)

Edit `brand/brand.config.json`, drop your logo at the referenced path, then:

```bash
pnpm brand:sync   # stamps the Tauri config, UI theme tokens and runtime brand constants
```

---

## Releasing

Versioning is [Changesets](https://github.com/changesets/changesets)-driven:

1. `pnpm changeset` — describe your change.
2. Merge the auto-opened **“Version Packages”** PR → a `vX.Y.Z` tag is pushed.
3. [`release.yml`](.github/workflows/release.yml) builds Linux/macOS/Windows bundles and
   attaches them to the GitHub Release. The RedDB sidecar is pulled from
   [reddb's releases](https://github.com/reddb-io/reddb/releases) at build time.

---

## Roadmap

HTTP, environments, variable substitution, scripts/tests, six auth methods, keychain
secrets, the multi-protocol kinds (TCP/UDP/ping/WHOIS/DNS) and a command palette are in.
Next: WebSocket / GraphQL / SSE / gRPC, importers (Postman / Insomnia / OpenAPI / `.bru` /
curl / HAR), code generation and a richer CI runner — see [`.red/CONTEXT.md`](.red/CONTEXT.md).

---

<div align="center">
<sub>Built by <a href="https://reddb.io">RedDB.io</a> · MIT licensed · Powered by <a href="https://github.com/forattini-dev/recker">recker</a></sub>
</div>
