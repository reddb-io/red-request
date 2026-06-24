#!/usr/bin/env node
// Fast release preflight for the embedded RedDB sidecar.
//
// The desktop app cannot be packaged for Linux/Windows unless the pinned RedDB
// release exposes the prebuilt `red-<os>-<arch>` assets that fetch-reddb.mjs
// downloads. Check that up front so release jobs fail before runner setup,
// dependency install, and Tauri packaging work. Mirrors fetch-reddb.mjs's
// candidate logic: linux x86_64/aarch64 prefer the static (musl) `-static` asset
// and fall back to the glibc one, so the preflight passes iff the fetch will.
//
//   REDDB_VERSION=v1.11.0 node scripts/check-reddb-release-assets.mjs \
//     x86_64-unknown-linux-gnu x86_64-pc-windows-msvc
import { env, exit } from "node:process";

const REPO = "reddb-io/reddb";

// Candidate asset names for this triple in preference order (see fetch-reddb.mjs).
function assetCandidates(triple) {
  const [arch] = triple.split("-");
  const os = triple.includes("linux")
    ? "linux"
    : triple.includes("darwin")
      ? "darwin"
      : triple.includes("windows")
        ? "windows"
        : null;
  if (!os) throw new Error(`unsupported target triple: ${triple}`);
  const ext = os === "windows" ? ".exe" : "";
  const glibc = `red-${os}-${arch}${ext}`;
  const preferStatic =
    os === "linux" && (arch === "x86_64" || arch === "aarch64");
  return preferStatic ? [`red-${os}-${arch}-static`, glibc] : [glibc];
}

async function ghJson(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "red-request-reddb-preflight",
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  try {
    const res = await fetch(`https://api.github.com/${path}`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${res.statusText}`);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: check-reddb-release-assets.mjs <target-triple> [...]");
  exit(2);
}

const tag = env.REDDB_VERSION;

let release;
try {
  release = tag
    ? await ghJson(`repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`)
    : await ghJson(`repos/${REPO}/releases/latest`);
} catch (err) {
  console.error(`RedDB release preflight failed: ${err.message}`);
  console.error(
    "Publish the pinned RedDB release, fix REDDB_VERSION, or build the sidecar from source."
  );
  exit(1);
}

const available = new Set((release.assets ?? []).map((asset) => asset.name));
// Each target is satisfied if ANY of its candidates is published; record the one
// fetch-reddb.mjs would actually download (the first available, static-preferred).
const resolved = targets.map((triple) => {
  const names = assetCandidates(triple);
  return { triple, names, chosen: names.find((n) => available.has(n)) ?? null };
});
const missing = resolved.filter((r) => r.chosen === null);

if (missing.length > 0) {
  console.error(
    `RedDB ${release.tag_name} is missing required release assets:`
  );
  for (const { triple, names } of missing) {
    console.error(`  - ${triple} (need one of: ${names.join(", ")})`);
  }
  console.error("");
  console.error("Available assets:");
  for (const name of [...available].sort()) console.error(`  - ${name}`);
  exit(1);
}

console.log(
  `RedDB ${release.tag_name} has required assets: ${resolved.map((r) => r.chosen).join(", ")}`
);
