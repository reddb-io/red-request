#!/usr/bin/env node
// Provision the embedded RedDB sidecar binary for the desktop app.
//
// The binary (apps/desktop/src-tauri/binaries/red-<triple>) is gitignored, so a fresh
// clone / CI must build it from the RedDB source. This builds `red` (release) and copies
// it next to the Tauri app under the host target triple Tauri expects for externalBin.
//
//   node scripts/sync-reddb.mjs                 # builds from ../reddb (or $REDDB_SRC)
//   REDDB_SRC=/path/to/reddb node scripts/sync-reddb.mjs
//
// Requires a Rust toolchain. Pin RedDB to the latest release — see the always-latest rule.
import { execFileSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REDDB_SRC = resolve(process.env.REDDB_SRC ?? join(ROOT, "..", "reddb"));
const OUT_DIR = join(ROOT, "apps/desktop/src-tauri/binaries");

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

if (!existsSync(join(REDDB_SRC, "Cargo.toml"))) {
  console.error(
    `RedDB source not found at ${REDDB_SRC}. Set REDDB_SRC to the reddb repo path.`
  );
  process.exit(1);
}

// Host target triple Tauri uses to resolve the sidecar (e.g. x86_64-unknown-linux-gnu).
const hostLine = sh("rustc", ["-vV"])
  .split("\n")
  .find((l) => l.startsWith("host:"));
const triple = hostLine?.split(/\s+/)[1];
if (!triple) {
  console.error("Could not determine host target triple from `rustc -vV`.");
  process.exit(1);
}

const version = (() => {
  try {
    return sh(join(REDDB_SRC, "target/release/red"), ["version"]).trim();
  } catch {
    return "reddb (building…)";
  }
})();

console.log(`Building RedDB \`red\` (release) from ${REDDB_SRC} …`);
// --message-format=json so we can locate the artifact regardless of CARGO_TARGET_DIR.
const out = sh(
  "cargo",
  ["build", "--release", "--bin", "red", "--message-format=json"],
  { cwd: REDDB_SRC, maxBuffer: 64 * 1024 * 1024 }
);
let exe;
for (const line of out.split("\n")) {
  if (!line.startsWith("{")) continue;
  try {
    const msg = JSON.parse(line);
    if (
      msg.reason === "compiler-artifact" &&
      msg.executable?.endsWith("/red")
    ) {
      exe = msg.executable;
    }
  } catch {
    /* skip non-JSON */
  }
}
// Fallback to the conventional path if the JSON stream didn't surface it.
exe ??= join(REDDB_SRC, "target/release/red");
if (!existsSync(exe)) {
  console.error(
    `Built but could not locate the \`red\` binary (looked at ${exe}).`
  );
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const dest = join(OUT_DIR, `red-${triple}`);
copyFileSync(exe, dest);
chmodSync(dest, 0o755);

const builtVersion = sh(dest, ["version"]).trim();
console.log(`✔ ${builtVersion} → ${dest}`);
