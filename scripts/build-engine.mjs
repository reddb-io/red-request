#!/usr/bin/env node
// Bundle the recker sidecar into a single self-contained binary and place it where Tauri
// expects an `externalBin` (apps/desktop/src-tauri/binaries/<name>-<target-triple>).
//
// Production target: Bun (`bun build --compile`) → one file, no node_modules.
// Requires a modern Bun (>= 1.x; see .tool-versions). In dev, Tauri can instead spawn the
// engine via `node`/`bun` from PATH (see the Rust shell's PATH fallback), so this script
// is only needed for packaging a release.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "packages/engine/src/main.ts");
const outDir = resolve(root, "apps/desktop/src-tauri/binaries");
mkdirSync(outDir, { recursive: true });

// Tauri's target-triple naming convention for externalBin.
function targetTriple() {
  try {
    const rustc = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const host = rustc.split("\n").find((l) => l.startsWith("host:"));
    if (host) return host.replace("host:", "").trim();
  } catch {
    /* rustc not available; fall back below */
  }
  const { platform, arch } = process;
  const a = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : arch;
  if (platform === "linux") return `${a}-unknown-linux-gnu`;
  if (platform === "darwin") return `${a}-apple-darwin`;
  if (platform === "win32") return `${a}-pc-windows-msvc`;
  throw new Error(`unsupported platform ${platform}`);
}

const triple = targetTriple();
const ext = process.platform === "win32" ? ".exe" : "";
const outfile = resolve(outDir, `red-request-engine-${triple}${ext}`);

if (!existsSync(entry)) {
  console.error(`engine entry not found: ${entry}`);
  process.exit(1);
}

console.log(`engine:build → ${outfile}`);
try {
  execFileSync(
    "bun",
    ["build", entry, "--compile", "--target=bun", "--outfile", outfile],
    { stdio: "inherit", cwd: root }
  );
  console.log("engine:build done.");
} catch (err) {
  console.error(
    "\nengine:build failed. Ensure a modern Bun is active (>= 1.x).\n" +
      "  asdf install bun 1.3.14   # the version pinned in .tool-versions\n" +
      "In dev you can skip this and let Tauri spawn the engine from PATH.\n"
  );
  process.exit(1);
}
