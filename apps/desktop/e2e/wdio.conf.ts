import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

// End-to-end harness for the real packaged app, Linux only (Tauri's WebDriver
// path supports Linux + Windows, not macOS). Drives the native WebKitGTK webview
// through `tauri-driver`, which forwards to `WebKitWebDriver`. The app boots its
// own reddb sidecar, so a spec exercises the full stack: UI → invoke → Rust →
// red connect → reddb → AS OF.
//
// Prereqs (see e2e/README.md): `cargo install tauri-driver`,
// `apt install webkit2gtk-driver xvfb`, and a built binary
// (`pnpm --filter @reddb-io/request-desktop build:tauri`).

// Built binary. target-dir is /opt/cargo-target on this machine (~/.cargo/config);
// override with TAURI_APP_PATH if yours differs.
const application =
  process.env.TAURI_APP_PATH ??
  [
    "/opt/cargo-target/release/red-request",
    "src-tauri/target/release/red-request",
  ].find(existsSync) ??
  "/opt/cargo-target/release/red-request";

let tauriDriver: ChildProcess | undefined;

export const config: WebdriverIO.Config = {
  hostname: "127.0.0.1",
  port: 4444,
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities: [
    {
      // @ts-expect-error tauri:options is a tauri-driver custom capability
      "tauri:options": { application },
    },
  ],
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 120_000 },
  logLevel: "warn",

  // Spin tauri-driver up for the run and tear it down after. It must be on PATH
  // (`cargo install tauri-driver` puts it in ~/.cargo/bin).
  onPrepare: () => {
    if (!existsSync(application)) {
      throw new Error(
        `App binary not found at ${application}. Build it first ` +
          `(pnpm --filter @reddb-io/request-desktop build:tauri) or set TAURI_APP_PATH.`
      );
    }
    if (spawnSync("which", ["tauri-driver"]).status !== 0) {
      throw new Error(
        "tauri-driver not found on PATH — run `cargo install tauri-driver`."
      );
    }
    tauriDriver = spawn("tauri-driver", [], {
      stdio: [null, process.stdout, process.stderr],
    });
  },
  onComplete: () => {
    tauriDriver?.kill();
  },
};
