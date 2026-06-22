#!/usr/bin/env node
// set-version.mjs <semver> — drive the WHOLE monorepo to one version in lock-step.
//
// Writes the version into every workspace package.json (root + packages/* + apps/*) and the
// Tauri desktop manifests (tauri.conf.json + src-tauri/Cargo.toml). This is the single knob
// the auto-release workflow turns so "which version is this?" has exactly one answer across
// JS packages, the desktop app, and the Rust crate. Idempotent. Mirrors reddb's
// scripts/sync-version.js and red-skills' catalog-synced versioning.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const r = (...p) => resolve(root, ...p);

const version = (process.argv[2] || "").trim();
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: set-version.mjs <semver>   e.g. 0.2.0");
  process.exit(1);
}

// Every workspace package.json: the root plus one level under packages/ and apps/.
const pkgPaths = ["package.json"];
for (const grp of ["packages", "apps"]) {
  if (!existsSync(r(grp))) continue;
  for (const name of readdirSync(r(grp))) {
    const p = `${grp}/${name}/package.json`;
    if (existsSync(r(p))) pkgPaths.push(p);
  }
}

for (const p of pkgPaths) {
  const json = JSON.parse(readFileSync(r(p), "utf8"));
  if (json.version === version) {
    console.log(`  =        ${p}`);
    continue;
  }
  json.version = version;
  writeFileSync(r(p), JSON.stringify(json, null, 2) + "\n");
  console.log(`  ${version}  ${p}`);
}

// Tauri desktop carries its own version in tauri.conf.json and Cargo.toml.
const tauriConf = "apps/desktop/src-tauri/tauri.conf.json";
if (existsSync(r(tauriConf))) {
  const conf = JSON.parse(readFileSync(r(tauriConf), "utf8"));
  conf.version = version;
  writeFileSync(r(tauriConf), JSON.stringify(conf, null, 2) + "\n");
  console.log(`  ${version}  ${tauriConf}`);
}

const cargo = "apps/desktop/src-tauri/Cargo.toml";
if (existsSync(r(cargo))) {
  const src = readFileSync(r(cargo), "utf8");
  // Only the [package] version: a standalone `version = "…"` line (deps use inline tables).
  writeFileSync(r(cargo), src.replace(/^version = "[^"]*"$/m, `version = "${version}"`));
  console.log(`  ${version}  ${cargo}`);
}

console.log(`set-version → ${version}`);
