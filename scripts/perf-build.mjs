#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flags = new Set(process.argv.slice(2));
const runRustRelease = flags.has("--rust-release");
const runUi = flags.has("--ui") || !runRustRelease;
const outDir = resolve(root, ".red/tmp");
mkdirSync(outDir, { recursive: true });

function rel(path) {
  return path.startsWith(root) ? path.slice(root.length + 1) : path;
}

function nowId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function gitValue(args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitSummary() {
  return {
    branch: gitValue(["branch", "--show-current"]),
    head: gitValue(["rev-parse", "--short", "HEAD"]),
  };
}

function run(label, command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const started = performance.now();
    console.log(`\n==> ${label}`);
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, ...options.env },
    });
    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      const seconds = Number(((performance.now() - started) / 1000).toFixed(2));
      const record = { label, seconds, code, signal };
      if (code === 0) resolveRun(record);
      else
        rejectRun(
          Object.assign(new Error(`${label} failed with ${code ?? signal}`), {
            record,
          })
        );
    });
  });
}

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walkFiles(path, out);
    else out.push(path);
  }
  return out;
}

function fileSize(path) {
  if (!existsSync(path)) return null;
  return statSync(path).size;
}

function bundleSummary() {
  const clientRoot = resolve(root, "packages/ui/.svelte-kit/output/client");
  const immutable = join(clientRoot, "_app/immutable");
  const manifestPath = join(clientRoot, ".vite/manifest.json");
  const js = walkFiles(immutable)
    .filter((path) => path.endsWith(".js"))
    .map((path) => {
      const bytes = readFileSync(path);
      return {
        path: rel(path),
        bytes: bytes.length,
        gzipBytes: gzipSync(bytes).length,
      };
    })
    .sort((a, b) => b.bytes - a.bytes);

  let routeInitial = null;
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const routeKey = Object.keys(manifest).find((key) =>
      key.includes("nodes/2")
    );
    if (routeKey) {
      const seen = new Set();
      const visit = (key) => {
        if (seen.has(key) || !manifest[key]) return;
        seen.add(key);
        for (const next of manifest[key].imports ?? []) visit(next);
      };
      visit(routeKey);
      let bytes = 0;
      let gzipBytes = 0;
      for (const key of seen) {
        const file = join(clientRoot, manifest[key].file);
        const content = readFileSync(file);
        bytes += content.length;
        gzipBytes += gzipSync(content).length;
      }
      routeInitial = {
        files: seen.size,
        bytes,
        gzipBytes,
        routeFile: manifest[routeKey].file,
      };
    }
  }

  return {
    largestClientJs: js.slice(0, 10),
    routeInitial,
  };
}

async function measureUi(records) {
  records.push(
    await run("core build", "pnpm", ["--filter", "@red-request/core", "build"])
  );
  records.push(
    await run("ui build", "pnpm", ["--filter", "@red-request/ui", "build"])
  );
  return bundleSummary();
}

async function measureRustRelease(records) {
  const variants = [
    { name: "baseline", env: {} },
    { name: "strip", env: { CARGO_PROFILE_RELEASE_STRIP: "symbols" } },
    { name: "thin-lto", env: { CARGO_PROFILE_RELEASE_LTO: "thin" } },
    {
      name: "thin-lto-codegen1-strip",
      env: {
        CARGO_PROFILE_RELEASE_LTO: "thin",
        CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
        CARGO_PROFILE_RELEASE_STRIP: "symbols",
      },
    },
  ];
  const out = [];
  for (const variant of variants) {
    const targetDir = resolve(outDir, `cargo-target-${variant.name}`);
    const record = await run(
      `cargo release ${variant.name}`,
      "cargo",
      [
        "build",
        "--release",
        "--locked",
        "--manifest-path",
        "apps/desktop/src-tauri/Cargo.toml",
      ],
      {
        env: {
          CARGO_TARGET_DIR: targetDir,
          ...variant.env,
        },
      }
    );
    records.push(record);
    const ext = process.platform === "win32" ? ".exe" : "";
    out.push({
      name: variant.name,
      seconds: record.seconds,
      binaryBytes: fileSize(join(targetDir, "release", `red-request${ext}`)),
      env: variant.env,
    });
  }
  return out;
}

const records = [];
const result = {
  generatedAt: new Date().toISOString(),
  git: gitSummary(),
  commands: records,
  ui: null,
  rustRelease: null,
};

try {
  if (runUi) result.ui = await measureUi(records);
  if (runRustRelease) result.rustRelease = await measureRustRelease(records);

  const output = resolve(outDir, `perf-build-${nowId()}.json`);
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\nWrote ${rel(output)}`);
  if (result.ui?.largestClientJs?.[0]) {
    const largest = result.ui.largestClientJs[0];
    console.log(
      `Largest client JS: ${(largest.bytes / 1024).toFixed(1)} KiB (${(largest.gzipBytes / 1024).toFixed(1)} KiB gzip) ${largest.path}`
    );
  }
  if (result.ui?.routeInitial) {
    const route = result.ui.routeInitial;
    console.log(
      `Route initial JS: ${(route.bytes / 1024).toFixed(1)} KiB (${(route.gzipBytes / 1024).toFixed(1)} KiB gzip), ${route.files} files`
    );
  }
} catch (error) {
  if (error.record) records.push(error.record);
  const output = resolve(outDir, `perf-build-failed-${nowId()}.json`);
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.error(error instanceof Error ? error.message : error);
  console.error(`Wrote ${rel(output)}`);
  process.exit(1);
}
