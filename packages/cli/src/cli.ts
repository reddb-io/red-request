#!/usr/bin/env node
// rr-run — run a git-versioned Red Request YAML export tree headlessly (CI). It loads each
// collection (collection.yaml + requests/*.yaml + environments/*.yaml), runs every request
// through the same engine pipeline the app uses (scripts + assertions included) and exits
// non-zero if anything fails. Collections live in git, this runs them — the git-native loop.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import {
  collectionFileSchema,
  requestDefinitionSchema,
  environmentFileSchema,
  mergeScopes,
  type RequestDefinition,
} from "@reddb-io/request-core";
import { runPipeline } from "@reddb-io/request-engine";

function help(): void {
  console.log(`rr-run — headless Red Request collection runner

Usage:
  rr-run <dir> [--env <name>] [--grep <substr>] [--bail]

  <dir>          a YAML export tree (a collection dir, or a parent of several)
  --env <name>   apply this environment's variables
  --grep <s>     only run requests whose name contains <s>
  --bail         stop at the first failure
`);
}

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "item";

const args = process.argv.slice(2);
let dir = "";
let envName = "";
let grep = "";
let bail = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--env") envName = args[++i] ?? "";
  else if (a === "--grep") grep = args[++i] ?? "";
  else if (a === "--bail") bail = true;
  else if (a === "-h" || a === "--help") {
    help();
    process.exit(0);
  } else if (!a.startsWith("-")) dir = a;
}
if (!dir) {
  help();
  process.exit(1);
}
dir = resolve(dir);

function findCollections(root: string): string[] {
  if (existsSync(join(root, "collection.yaml"))) return [root];
  const out: string[] = [];
  for (const e of readdirSync(root)) {
    const p = join(root, e);
    if (statSync(p).isDirectory() && existsSync(join(p, "collection.yaml")))
      out.push(p);
  }
  return out;
}

const read = (p: string) => parse(readFileSync(p, "utf8"));
function orderBy(
  reqs: RequestDefinition[],
  order: string[]
): RequestDefinition[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...reqs].sort(
    (a, b) =>
      (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9) ||
      a.name.localeCompare(b.name)
  );
}

const colDirs = findCollections(dir);
if (!colDirs.length) {
  console.error(`rr-run: no collection.yaml found under ${dir}`);
  process.exit(1);
}

let okReqs = 0,
  failReqs = 0,
  okTests = 0,
  failTests = 0;

function finish(code: number): never {
  console.log(
    `\n${okReqs} ok · ${failReqs} failed   ·   tests: ${okTests} passed, ${failTests} failed`
  );
  process.exit(code);
}

for (const cdir of colDirs) {
  const collection = collectionFileSchema.parse(
    read(join(cdir, "collection.yaml"))
  );
  let envVars: Record<string, string> = {};
  if (envName) {
    const ep = join(cdir, "environments", `${slugify(envName)}.yaml`);
    if (existsSync(ep)) envVars = environmentFileSchema.parse(read(ep)).vars;
    else console.error(`  ! env "${envName}" not found in ${collection.name}`);
  }
  const lookup = mergeScopes([envVars, collection.vars]);

  const reqDir = join(cdir, "requests");
  const reqs = existsSync(reqDir)
    ? readdirSync(reqDir)
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => requestDefinitionSchema.parse(read(join(reqDir, f))))
    : [];
  const ordered = orderBy(reqs, collection.order ?? []).filter(
    (r) => !grep || r.name.toLowerCase().includes(grep.toLowerCase())
  );

  console.log(
    `\n▶ ${collection.name}  (${ordered.length} requests${envName ? `, env=${envName}` : ""})`
  );
  for (const req of ordered) {
    const out = await runPipeline(req, lookup);
    const res = out.response;
    const tests = out.scriptResult?.tests ?? [];
    const failed = tests.filter((t) => !t.passed).length;
    const reqOk = res.ok && !res.error && failed === 0;
    reqOk ? okReqs++ : failReqs++;
    for (const t of tests) t.passed ? okTests++ : failTests++;
    const status = res.status || res.error?.message || "ERR";
    console.log(
      `  ${reqOk ? "✓" : "✗"} ${req.name}  →  ${status}  ${Math.round(res.durationMs)}ms`
    );
    for (const t of tests)
      console.log(
        `     ${t.passed ? "✓" : "✗"} ${t.name}${t.error ? ` — ${t.error}` : ""}`
      );
    if (out.scriptResult?.error)
      console.log(`     ! script: ${out.scriptResult.error}`);
    if (bail && !reqOk) finish(1);
  }
}

finish(failReqs || failTests ? 1 : 0);
