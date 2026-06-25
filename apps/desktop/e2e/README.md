# End-to-end tests (Linux)

Drives the **real packaged app** through Tauri's WebDriver path: WebdriverIO →
`tauri-driver` → `WebKitWebDriver` → the WebKitGTK webview → the Rust backend →
the embedded reddb sidecar. This is the only layer that exercises the whole stack
(including native VCS: `History` → `/repo/commits` + `SELECT … AS OF`).

> Tauri WebDriver supports **Linux and Windows only** (no macOS). This project is
> Linux-first, so that's the target.

## One-time setup

```bash
# 1. tauri-driver (Rust) — lands in ~/.cargo/bin (on PATH)
cargo install tauri-driver

# 2. The native WebKit WebDriver + a headless display (need sudo)
sudo apt-get install -y webkit2gtk-driver xvfb
```

## Build the app (with the reddb sidecar bundled)

```bash
# fetches the reddb sidecar (latest, ≥1.15 for VCS) into externalBin, then builds
pnpm --filter @red-request/desktop build:tauri
```

The binary lands at `/opt/cargo-target/release/red-request` on this machine
(cargo `target-dir`). If yours differs, set `TAURI_APP_PATH`.

## Run

```bash
# headed (you watch it)
pnpm --filter @red-request/desktop test:e2e

# headless (CI / no display)
xvfb-run -a pnpm --filter @red-request/desktop test:e2e
```

## Files

- `wdio.conf.ts` — spawns/stops `tauri-driver`, points at the built binary.
- `specs/smoke.e2e.ts` — launches the app, asserts the UI renders (always-green smoke).
- `specs/history.e2e.ts` — native-VCS History flow **template** (`.skip`; fill in the
  steps to reach a selected request, then enable). The History button carries
  `data-testid="request-history-btn"`.

## Notes

- The app spawns its own reddb sidecar, so no separate DB setup is needed — but the
  build must include the sidecar (the `build:tauri` step does the fetch).
- `tauri-driver` listens on `127.0.0.1:4444`; close other WebDriver servers on that port.
