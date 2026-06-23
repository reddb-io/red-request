#!/usr/bin/env node
// Fast release preflight for the embedded RedDB sidecar.
//
// The desktop app cannot be packaged for Linux/Windows unless the pinned RedDB
// release exposes the prebuilt `red-<os>-<arch>` assets that fetch-reddb.mjs
// downloads. Check that up front so release jobs fail before runner setup,
// dependency install, and Tauri packaging work.
//
//   REDDB_VERSION=v1.11.0 node scripts/check-reddb-release-assets.mjs \
//     x86_64-unknown-linux-gnu x86_64-pc-windows-msvc
import { env, exit } from "node:process";

const REPO = "reddb-io/reddb";

function assetName(triple) {
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
  return `red-${os}-${arch}${ext}`;
}

async function ghJson(path) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "red-request-reddb-preflight",
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/${path}`, { headers });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${res.statusText}`);
  return res.json();
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: check-reddb-release-assets.mjs <target-triple> [...]");
  exit(2);
}

const required = targets.map(assetName);
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
const missing = required.filter((name) => !available.has(name));

if (missing.length > 0) {
  console.error(
    `RedDB ${release.tag_name} is missing required release assets:`
  );
  for (const name of missing) console.error(`  - ${name}`);
  console.error("");
  console.error("Available assets:");
  for (const name of [...available].sort()) console.error(`  - ${name}`);
  exit(1);
}

console.log(
  `RedDB ${release.tag_name} has required assets: ${required.join(", ")}`
);
