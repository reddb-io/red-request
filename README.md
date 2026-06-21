<div align="center">

<img src="docs/hero.svg" alt="Red Request — the open-source, white-label API client" width="100%" />

<p>
  <a href="https://github.com/reddb-io/red-request/releases"><img src="https://img.shields.io/github/v/release/reddb-io/red-request?style=for-the-badge&color=ff2056&labelColor=0b0b0d" alt="Release"></a>
  <a href="https://github.com/reddb-io/red-request/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/reddb-io/red-request/ci.yml?branch=main&style=for-the-badge&label=CI&labelColor=0b0b0d" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge&labelColor=0b0b0d" alt="License"></a>
  <img src="https://img.shields.io/badge/linux%20·%20macOS%20·%20windows-555?style=for-the-badge&labelColor=0b0b0d&label=runs%20on" alt="Platforms">
</p>

<strong>A Bruno/Insomnia alternative that's native, offline-first, git-friendly and truly yours.</strong><br>
Built on the <a href="https://github.com/forattini-dev/recker"><code>recker</code></a> multi-protocol SDK · shipped as a <a href="https://tauri.app">Tauri&nbsp;2</a> app · <strong>no Electron, no account, no telemetry.</strong>

</div>

---

## ⚡ Install

```bash
# Linux — one line, that's it.
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-request/main/install.sh | bash
```

<div align="center"><sub>or grab your platform from the <a href="https://github.com/reddb-io/red-request/releases/latest"><b>latest release</b></a> ↓</sub></div>

| 🐧 Linux             | 🍎 macOS                       | 🪟 Windows                 |
| -------------------- | ------------------------------ | -------------------------- |
| `.AppImage` · `.deb` | `.dmg` — Apple Silicon & Intel | `.msi` · NSIS `-setup.exe` |

> Builds are unsigned for now — macOS: right-click → **Open** · Windows: **More info → Run anyway**.

---

## ✨ Why you'll like it

|                           |                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ⚡ **Native & instant**   | A Rust (Tauri) shell around a Svelte 5 UI. Cold-starts in a blink, sips RAM — none of the Electron tax.                                                      |
| 🔌 **Multi-protocol**     | Every request runs through **recker**. **HTTP, TCP, UDP, ping, WHOIS and DNS** ship today as first-class request _kinds_. WS / GraphQL / SSE / gRPC next.    |
| 💾 **Offline-first**      | Your work lives in a local **RedDB** `.rdb` — no cloud, no sign-in, no "sync conflict".                                                                      |
| 🌿 **Git-friendly**       | Export collections to a clean **YAML** tree (one request per file) you can diff and review in PRs. Secrets never leave.                                      |
| 🔐 **Secrets done right** | Sealed with **AES-256-GCM**, master key in your **OS keychain**. Never exported, never plaintext.                                                            |
| 🎨 **White-label**        | Name, icon, accent, deep-link scheme — all from one `brand.config.json`. Ship it as _your_ product without forking logic.                                    |
| 🧠 **Power tools**        | `⌘K` command palette, a runner (repeat / data-driven / flow), drag-to-reorder params, a code editor with line numbers + Prettify, and native SQL migrations. |
| 🆓 **100% MIT**           | Free forever. Yours to fork, rebrand and ship.                                                                                                               |

---

## 🆚 How it compares

|                            | **Red Request** | Bruno |  Insomnia  | Postman |
| -------------------------- | :-------------: | :---: | :--------: | :-----: |
| Open source                |     ✅ MIT      |  ✅   | ⚠️ partial |   ❌    |
| Works fully offline        |       ✅        |  ✅   |     ⚠️     |   ❌    |
| No account required        |       ✅        |  ✅   |     ❌     |   ❌    |
| Git-friendly files         |     ✅ YAML     |  ✅   |     ⚠️     |   ❌    |
| Native (no Electron)       |    ✅ Tauri     |  ❌   |     ❌     |   ❌    |
| Beyond HTTP (TCP/UDP/DNS…) |       ✅        |  ⚠️   |     ⚠️     |   ⚠️    |
| White-label / rebrandable  |       ✅        |  ❌   |     ❌     |   ❌    |

---

## 🏗 Architecture

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

## 🚀 Develop

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

Edit `brand/brand.config.json`, drop your logo at the referenced path, then:

```bash
pnpm brand:sync   # stamps the Tauri config, UI theme tokens and runtime brand constants
```

</details>

<details>
<summary><b>Releasing (Changesets → tag → bundles)</b></summary>

1. `pnpm changeset` — describe your change.
2. Merge the auto-opened **“Version Packages”** PR → `v*` is tagged and
   [`release.yml`](.github/workflows/release.yml) is dispatched (no PAT needed).
3. It builds Linux/macOS/Windows bundles and attaches them to the GitHub Release. The RedDB
sidecar is pulled from [reddb's releases](https://github.com/reddb-io/reddb/releases) at
build time (macOS builds it from source until reddb ships darwin binaries).
</details>

---

## 🗺 Roadmap

✅ HTTP · environments · variables · scripts & tests · 6 auth methods · keychain secrets ·
TCP/UDP/ping/WHOIS/DNS kinds · `⌘K` palette · runner · drag-reorder · code editor.
**Next:** WebSocket / GraphQL / SSE / gRPC · importers (Postman / Insomnia / OpenAPI / `.bru`
/ curl / HAR) · code generation · richer CI runner — see [`.red/CONTEXT.md`](.red/CONTEXT.md).

---

<div align="center">
<sub>Built by <a href="https://reddb.io">RedDB.io</a> · MIT · powered by <a href="https://github.com/forattini-dev/recker">recker</a> & <a href="https://github.com/reddb-io/reddb">RedDB</a></sub>
</div>
