<div align="center">

<img src="docs/hero.svg" alt="Red Request — the open-source, white-label API client" width="100%" />

<p>
  <a href="https://github.com/reddb-io/red-request/releases"><img src="https://img.shields.io/github/v/release/reddb-io/red-request?style=for-the-badge&color=ff2056&labelColor=0b0b0d" alt="Release"></a>
  <a href="https://github.com/reddb-io/red-request/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/reddb-io/red-request/ci.yml?branch=main&style=for-the-badge&label=CI&labelColor=0b0b0d" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge&labelColor=0b0b0d" alt="License"></a>
  <img src="https://img.shields.io/badge/linux%20·%20macOS%20·%20windows-555?style=for-the-badge&labelColor=0b0b0d&label=runs%20on" alt="Platforms">
</p>

<strong>The API client that respects you</strong> — native, offline-first, git-friendly, and entirely yours to rebrand.<br>
Built on the <a href="https://github.com/forattini-dev/recker"><code>recker</code></a> multi-protocol SDK and shipped as a <a href="https://tauri.app">Tauri&nbsp;2</a> desktop app. No Electron. No account. No telemetry.

</div>

---

## Install

```bash
# Linux — one line.
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-request/main/install.sh | bash
```

Prefer a click? Grab your platform from the **[latest release](https://github.com/reddb-io/red-request/releases/latest)**:

| Linux  | macOS                  | Windows                    |
| ------ | ---------------------- | -------------------------- |
| `.deb` | `.dmg` (Apple Silicon) | `.msi` · NSIS `-setup.exe` |

<sub>Builds are unsigned for now — macOS: right-click → **Open** · Windows: **More info → Run anyway**.</sub>

---

## What makes it nice

**Variables that light up.** Type `{{token}}` anywhere — URL, path params, query, headers,
body — and it renders highlighted: **green** when the variable resolves in scope, **red** when
it doesn't. Open a `{{` and an autocomplete of every known variable drops in. Path segments
like `/users/:id` are detected automatically and take a literal _or_ a `{{var}}` from your
environment.

**A real editor, not a textarea.** The request body and the response come with a line-number
gutter, a current-line highlight, one-click **Prettify** for JSON, and **Copy** on the
response. Pick a body type and the matching `Content-Type` and `Accept` headers are written
for you.

**Beyond HTTP.** Every request is dispatched through **recker**, so alongside HTTP you get
**TCP, UDP, ping, WHOIS and DNS** as first-class request kinds — with the same variables,
history and latency dashboard. WebSocket / GraphQL / SSE / gRPC are next.

**Move at the speed of thought.** A `⌘K` command palette jumps to any request or action. A
runner replays a request as a **repeat**, a **data-driven** sweep, or a **flow** that threads
`setVar` between steps. Query, header and form rows **drag to reorder**.

**Your data, your disk.** Everything lives in a local **RedDB** store — no cloud, no sign-in.
Export to a clean **YAML** tree (one request per file) to diff and review in PRs; secrets never
leave. Those secrets are sealed with **AES-256-GCM**, the master key kept in your **OS
keychain**.

**Truly white-label.** Product name, icon, accent colour and deep-link scheme all come from a
single `brand.config.json`. Ship it as _your_ product without forking a line of logic.

---

## How it compares

|                            | **Red Request** | Bruno | Insomnia | Postman |
| -------------------------- | :-------------: | :---: | :------: | :-----: |
| Open source                |      MIT ✓      |   ✓   | partial  |    —    |
| Fully offline              |        ✓        |   ✓   | partial  |    —    |
| No account required        |        ✓        |   ✓   |    —     |    —    |
| Git-friendly files         |     YAML ✓      |   ✓   | partial  |    —    |
| Native (no Electron)       |     Tauri ✓     |   —   |    —     |    —    |
| Beyond HTTP (TCP/UDP/DNS…) |        ✓        |   ~   |    ~     |    ~    |
| White-label / rebrandable  |        ✓        |   —   |    —     |    —    |

---

## Architecture

```
 Webview  ── SvelteKit (static) · Svelte 5 · shadcn-svelte
    │  @tauri-apps/api (invoke + events)
 Tauri / Rust  ── fs · OS keychain (secrets) · theming · deep links
    ├─ NDJSON-RPC (stdio) ─▶  engine sidecar  ──▶  recker  ──▶  HTTP · TCP · UDP · DNS · WHOIS · ping
    └─ HTTP 127.0.0.1     ─▶  RedDB `red`      ──▶  embedded .rdb store
```

recker is TypeScript over raw sockets, so it can't live in the webview — it runs as a
**sidecar** the Rust shell spawns and talks to over stdio. RedDB is a second sidecar serving
the local store. Decisions live in [`.red/adr/`](.red/adr); the glossary in
[`.red/CONTEXT.md`](.red/CONTEXT.md).

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
pnpm reddb:fetch     # download the RedDB sidecar (or pnpm reddb:sync to build from ../reddb)
pnpm desktop:dev     # launch the app with hot reload  ·  (pnpm dev = browser UI shell)
```

<details>
<summary><b>Projects — point the app at a folder (<code>rr .</code>)</b></summary>

A folder becomes a project when you open the app pointed at it — its data lives in
`<folder>/.red/request/app.rdb`, which you can commit. No folder ⇒ the global
`~/.red/request/app.rdb`.

```bash
pnpm desktop:build
ln -s "$PWD/scripts/rr" ~/.local/bin/rr
rr .                  # open the project rooted here
rr ~/work/my-api      # …or another folder
rr                    # global store
```

</details>

<details>
<summary><b>Rebrand it (white-label)</b></summary>

Edit `brand/brand.config.json`, drop your logo at the referenced path, then `pnpm brand:sync`
to stamp the Tauri config, UI theme tokens and runtime brand constants.

</details>

<details>
<summary><b>Releasing (Changesets → tag → bundles)</b></summary>

`pnpm changeset` to describe a change. Merging the auto-opened **“Version Packages”** PR tags
`v*` and dispatches [`release.yml`](.github/workflows/release.yml) (no PAT needed), which builds
Linux/macOS/Windows bundles on Blacksmith runners and attaches them to the GitHub Release. The
RedDB sidecar is pulled from [reddb's releases](https://github.com/reddb-io/reddb/releases) at
build time (built from source on macOS until reddb ships darwin binaries).

</details>

---

## Roadmap

Shipped: HTTP · environments · variables · scripts & tests · six auth methods · keychain
secrets · TCP/UDP/ping/WHOIS/DNS · `⌘K` palette · runner · drag-reorder · code editor.
Next: WebSocket / GraphQL / SSE / gRPC · importers (Postman / Insomnia / OpenAPI / `.bru` /
curl / HAR) · code generation · a richer CI runner — see [`.red/CONTEXT.md`](.red/CONTEXT.md).

---

<div align="center">
<sub>Built by <a href="https://reddb.io">RedDB.io</a> · MIT · powered by <a href="https://github.com/forattini-dev/recker">recker</a> &amp; <a href="https://github.com/reddb-io/reddb">RedDB</a></sub>
</div>
