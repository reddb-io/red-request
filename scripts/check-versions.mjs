#!/usr/bin/env node
// check-versions.mjs — assert every monorepo manifest carries the SAME version.
//
// The release gate that makes version drift impossible to ship: it reads the root +
// every packages/* and apps/* package.json plus the Tauri tauri.conf.json / Cargo.toml,
// and exits non-zero if they disagree. Run it after set-version.mjs (the auto-release
// workflow does) and anywhere you want to prove the monorepo speaks one version.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const r = (...p) => resolve(root, ...p);

const found = [];
const addPkg = (p) => {
  if (existsSync(r(p))) found.push([p, JSON.parse(readFileSync(r(p), "utf8")).version]);
};

addPkg("package.json");
for (const grp of ["packages", "apps"]) {
  if (!existsSync(r(grp))) continue;
  for (const name of readdirSync(r(grp))) addPkg(`${grp}/${name}/package.json`);
}

const tauriConf = "apps/desktop/src-tauri/tauri.conf.json";
if (existsSync(r(tauriConf)))
  found.push([tauriConf, JSON.parse(readFileSync(r(tauriConf), "utf8")).version]);

const cargo = "apps/desktop/src-tauri/Cargo.toml";
if (existsSync(r(cargo))) {
  const m = readFileSync(r(cargo), "utf8").match(/^version = "([^"]*)"$/m);
  found.push([cargo, m ? m[1] : undefined]);
}

for (const [p, v] of found) console.log(`  ${v ?? "—"}  ${p}`);

const versions = [...new Set(found.map(([, v]) => v))];
if (versions.length !== 1 || versions[0] === undefined) {
  console.error(`\n✗ version drift across the monorepo: ${versions.join(", ")}`);
  process.exit(1);
}
console.log(`\n✓ all ${found.length} manifests agree on ${versions[0]}`);
