#!/usr/bin/env node
// Propagate the workspace version into the Tauri desktop app (tauri.conf.json + Cargo.toml
// + apps/desktop/package.json) so the shipped app stays in lock-step with the packages.
// Mirrors red-ui's release:version step. Idempotent.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const r = (p) => resolve(root, p);
const version = JSON.parse(
  readFileSync(r("packages/core/package.json"), "utf8")
).version;

function patch(path, fn) {
  if (!existsSync(r(path))) return console.log(`  skip   ${path}`);
  writeFileSync(r(path), fn(readFileSync(r(path), "utf8")));
  console.log(`  v${version} ${path}`);
}

patch("apps/desktop/src-tauri/tauri.conf.json", (s) => {
  const c = JSON.parse(s);
  c.version = version;
  return JSON.stringify(c, null, 2) + "\n";
});
// NOTE: deliberately do NOT bump apps/desktop/package.json — it's `ignore`d by changesets,
// and bumping it mid-`changeset version` makes changesets/action treat it as a released
// package and read its (nonexistent) CHANGELOG.md → ENOENT. The real app version lives in
// tauri.conf.json + Cargo.toml.
patch("apps/desktop/src-tauri/Cargo.toml", (s) =>
  s.replace(/^version = ".*"$/m, `version = "${version}"`)
);

console.log(`sync-desktop-version → ${version}`);
