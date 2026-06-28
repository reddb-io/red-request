#!/usr/bin/env node
// Provision the embedded RedDB sidecar binary for the desktop app.
//
// The binary (apps/desktop/src-tauri/binaries/red-<triple>[.exe]) is gitignored, so a fresh
// clone / CI must build it from the RedDB source. This builds `red` (release) and copies
// it next to the Tauri app under the host target triple Tauri expects for externalBin.
//
//   node scripts/sync-reddb.mjs                 # builds from ../reddb (or $REDDB_SRC)
//   REDDB_SRC=/path/to/reddb node scripts/sync-reddb.mjs
//   REDDB_SRC=/path/to/reddb REDDB_TARGET=aarch64-apple-darwin node scripts/sync-reddb.mjs
//
// Requires a Rust toolchain. Pin RedDB to the latest release — see the always-latest rule.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  chmodSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REDDB_SRC = resolve(process.env.REDDB_SRC ?? join(ROOT, "..", "reddb"));
const OUT_DIR = join(ROOT, "apps/desktop/src-tauri/binaries");
const RESOURCE_DIR = join(ROOT, "apps/desktop/src-tauri/resources");

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

if (!existsSync(join(REDDB_SRC, "Cargo.toml"))) {
  console.error(
    `RedDB source not found at ${REDDB_SRC}. Set REDDB_SRC to the reddb repo path.`
  );
  process.exit(1);
}

// Target triple Tauri uses to resolve the sidecar (e.g. x86_64-unknown-linux-gnu).
// CI passes REDDB_TARGET from the release matrix; local dev falls back to the host.
function targetTriple() {
  if (process.env.REDDB_TARGET) return process.env.REDDB_TARGET;
  const hostLine = sh("rustc", ["-vV"])
    .split("\n")
    .find((l) => l.startsWith("host:"));
  return hostLine?.split(/\s+/)[1];
}
const triple = targetTriple();
if (!triple) {
  console.error(
    "Could not determine target triple from REDDB_TARGET or `rustc -vV`."
  );
  process.exit(1);
}
const isWindows = triple.includes("windows");
const ext = isWindows ? ".exe" : "";

console.log(`Building RedDB \`red\` (release) from ${REDDB_SRC} …`);
// --message-format=json so we can locate the artifact regardless of CARGO_TARGET_DIR.
// Stream stdout to a temp JSONL file instead of execFileSync's memory buffer; a full
// RedDB release build can emit enough compiler JSON to make buffered output brittle.
const cargoArgs = [
  "build",
  "--release",
  "--bin",
  "red",
  "--target",
  triple,
  "--message-format=json",
];
const tmp = mkdtempSync(join(tmpdir(), "red-request-reddb-build-"));
const jsonPath = join(tmp, "cargo.jsonl");
const stdoutFd = openSync(jsonPath, "w");
const built = spawnSync("cargo", cargoArgs, {
  cwd: REDDB_SRC,
  stdio: ["ignore", stdoutFd, "inherit"],
});
closeSync(stdoutFd);
if (built.error) throw built.error;
if (built.status !== 0) {
  console.error(`cargo ${cargoArgs.join(" ")} exited with ${built.status}`);
  process.exit(built.status ?? 1);
}
const out = readFileSync(jsonPath, "utf8");
rmSync(tmp, { recursive: true, force: true });
let exe;
for (const line of out.split("\n")) {
  if (!line.startsWith("{")) continue;
  try {
    const msg = JSON.parse(line);
    if (
      msg.reason === "compiler-artifact" &&
      msg.target?.name === "red" &&
      msg.target?.kind?.includes("bin") &&
      msg.executable
    ) {
      exe = msg.executable;
    }
  } catch {
    /* skip non-JSON */
  }
}
// Fallback to the conventional path if the JSON stream didn't surface it.
exe ??= join(REDDB_SRC, "target", triple, "release", `red${ext}`);
if (!existsSync(exe)) {
  console.error(
    `Built but could not locate the \`red\` binary (looked at ${exe}).`
  );
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const dest = join(OUT_DIR, `red-${triple}${ext}`);
copyFileSync(exe, dest);
if (!isWindows) chmodSync(dest, 0o755);

mkdirSync(RESOURCE_DIR, { recursive: true });
const resource = join(RESOURCE_DIR, `red-${triple}${ext}.gz`);
writeFileSync(resource, gzipSync(readFileSync(exe), { level: 9 }));

let builtVersion = `red built for ${triple}`;
try {
  builtVersion = sh(dest, ["version"]).trim();
} catch {
  // Cross-built binaries may not run on the build host; the release matrix builds native
  // targets, so this is only a local-dev fallback.
}
console.log(`✔ ${builtVersion} → ${dest}`);
console.log(`✔ RedDB immutable resource → ${resource}`);
