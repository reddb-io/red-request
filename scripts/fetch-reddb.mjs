#!/usr/bin/env node
// Provision the embedded RedDB sidecar by DOWNLOADING a prebuilt `red` binary from RedDB's
// own GitHub releases — instead of compiling it from source (see scripts/sync-reddb.mjs,
// used for local dev against ../reddb). This is what CI uses: it reuses RedDB's release
// infra, so we never need the reddb source tree or a Rust build of it.
//
//   node scripts/fetch-reddb.mjs                    # latest reddb release, host triple
//   REDDB_VERSION=v1.11.0 node scripts/fetch-reddb.mjs
//   REDDB_TARGET=aarch64-apple-darwin node scripts/fetch-reddb.mjs   # cross (CI matrix)
//
// Places the binary at apps/desktop/src-tauri/binaries/red-<triple>[.exe], the name Tauri
// resolves for `externalBin`. Pin REDDB_VERSION in release builds for reproducibility.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { createHash as hash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "apps/desktop/src-tauri/binaries");
const RESOURCE_DIR = join(ROOT, "apps/desktop/src-tauri/resources");
const REPO = "reddb-io/reddb";

// Tauri's externalBin host triple → RedDB's release asset name (os-arch).
function hostTriple() {
  if (process.env.REDDB_TARGET) return process.env.REDDB_TARGET;
  try {
    const rustc = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const host = rustc.split("\n").find((l) => l.startsWith("host:"));
    if (host) return host.replace("host:", "").trim();
  } catch {
    /* fall through */
  }
  const a =
    process.arch === "x64"
      ? "x86_64"
      : process.arch === "arm64"
        ? "aarch64"
        : process.arch;
  if (process.platform === "darwin") return `${a}-apple-darwin`;
  if (process.platform === "win32") return `${a}-pc-windows-msvc`;
  return `${a}-unknown-linux-gnu`;
}

// Candidate asset names for this triple, in preference order. Linux x86_64/aarch64 ship a
// fully *static* (musl) `red` as `<asset>-static`; prefer it. The dynamic `red-linux-<arch>`
// links the build host's glibc, so it fails to start on any host with an older glibc
// ("GLIBC_2.xx not found") — which black-screens the desktop app (the reddb sidecar
// crash-loops, the UI waits on it forever). The static build runs on any glibc. Fall back to
// the glibc asset for older reddb releases that predate the static one. Mirrors install.sh.
function assetCandidates(triple) {
  const [arch] = triple.split("-");
  const os = triple.includes("linux")
    ? "linux"
    : triple.includes("darwin")
      ? "darwin"
      : triple.includes("windows")
        ? "windows"
        : null;
  if (!os) throw new Error(`Unsupported target triple: ${triple}`);
  const ext = os === "windows" ? ".exe" : "";
  // reddb publishes darwin sidecars as `red-macos-<arch>`, not `red-darwin-<arch>`.
  const assetOs = os === "darwin" ? "macos" : os;
  const glibc = `red-${assetOs}-${arch}${ext}`;
  // The static variant is published only for the linux x86_64 / aarch64 sidecars.
  const preferStatic =
    os === "linux" && (arch === "x86_64" || arch === "aarch64");
  const names = preferStatic
    ? [`red-${assetOs}-${arch}-static`, glibc]
    : [glibc];
  return { names, ext, os };
}

async function ghJson(url) {
  const headers = { "User-Agent": "red-request-fetch-reddb" };
  if (process.env.GITHUB_TOKEN)
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function download(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "red-request-fetch-reddb" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`download ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const triple = hostTriple();
const { names, ext, os } = assetCandidates(triple);

const tag =
  process.env.REDDB_VERSION ||
  (await ghJson(`https://api.github.com/repos/${REPO}/releases/latest`))
    .tag_name;
if (!tag) throw new Error("could not determine a reddb release tag");

const base = `https://github.com/${REPO}/releases/download/${tag}`;

// Download the first candidate that exists. Fall back to the next ONLY on a 404 (asset not
// published in this release) — a real network/auth error still propagates instead of being
// masked by a fallback that would also fail.
let name, bin;
for (let i = 0; i < names.length; i++) {
  const candidate = names[i];
  console.log(`Fetching RedDB ${candidate} from ${REPO}@${tag} …`);
  try {
    bin = await download(`${base}/${candidate}`);
    name = candidate;
    break;
  } catch (e) {
    const last = i === names.length - 1;
    if (String(e).includes("→ 404") && !last) {
      console.log(
        `  (${candidate} not published in ${tag} — trying ${names[i + 1]})`
      );
      continue;
    }
    throw e;
  }
}

// Verify the published .sha256 sidecar when present (best-effort). Pull the hash out by
// regex so we don't care about the format: `<hash>  file` (sha256sum), `SHA256(file)= <hash>`
// (BSD/openssl), or a bare PowerShell Get-FileHash digest all work.
try {
  const sumText = (await download(`${base}/${name}.sha256`)).toString("utf8");
  const m = sumText.match(/[0-9a-fA-F]{64}/);
  const expected = m ? m[0].toLowerCase() : "";
  const actual = hash("sha256").update(bin).digest("hex");
  if (expected && expected !== actual) {
    throw new Error(
      `checksum mismatch for ${name}: expected ${expected}, got ${actual}`
    );
  }
  console.log(
    expected ? "  ✔ sha256 verified" : "  (no parseable checksum — skipped)"
  );
} catch (e) {
  if (String(e).includes("checksum mismatch")) throw e;
  console.log(`  (no .sha256 sidecar — skipping verification)`);
}

mkdirSync(OUT_DIR, { recursive: true });
const dest = join(OUT_DIR, `red-${triple}${ext}`);
writeFileSync(dest, bin);
if (os !== "windows") chmodSync(dest, 0o755);

// AppImage tooling mutates executable ELF files in usr/bin while bundling. Keep an
// immutable gzip copy as a Tauri resource; the app extracts it to cache and runs that
// copy instead of the mutated AppImage sidecar when the resource is present.
mkdirSync(RESOURCE_DIR, { recursive: true });
const resource = join(RESOURCE_DIR, `red-${triple}${ext}.gz`);
writeFileSync(resource, gzipSync(bin, { level: 9 }));

console.log(`✔ RedDB ${tag} → ${dest}`);
console.log(`✔ RedDB immutable resource → ${resource}`);
