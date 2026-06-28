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
    const captureOutput = Boolean(options.captureOutput);
    let output = "";
    console.log(`\n==> ${label}`);
    const child = spawn(command, args, {
      cwd: root,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...options.env },
    });
    if (captureOutput) {
      const collect = (stream, sink) => {
        stream.on("data", (chunk) => {
          const text = chunk.toString();
          output += text;
          sink.write(text);
        });
      };
      collect(child.stdout, process.stdout);
      collect(child.stderr, process.stderr);
    }
    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      const seconds = Number(((performance.now() - started) / 1000).toFixed(2));
      const record = { label, seconds, code, signal };
      if (captureOutput) record.output = output;
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

function commandRecord(record) {
  const { output, ...rest } = record;
  return rest;
}

function pushRecord(records, record) {
  records.push(commandRecord(record));
  return record;
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

function kib(bytes) {
  return (bytes / 1024).toFixed(1);
}

function gzipFileSummary(path) {
  const bytes = readFileSync(path);
  return {
    path: rel(path),
    bytes: bytes.length,
    gzipBytes: gzipSync(bytes).length,
  };
}

function jsSummary(dir) {
  const files = walkFiles(dir)
    .filter((path) => path.endsWith(".js"))
    .map(gzipFileSummary)
    .sort((a, b) => b.bytes - a.bytes);
  return {
    files,
    count: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
  };
}

function routeConfigSummary() {
  const layoutPath = resolve(root, "packages/ui/src/routes/+layout.ts");
  if (!existsSync(layoutPath)) {
    return { ssrFalse: null, prerenderTrue: null };
  }
  const source = readFileSync(layoutPath, "utf8");
  return {
    ssrFalse: /\bssr\s*=\s*false\b/.test(source),
    prerenderTrue: /\bprerender\s*=\s*true\b/.test(source),
  };
}

function bundleSummary(buildOutput = "") {
  const clientRoot = resolve(root, "packages/ui/.svelte-kit/output/client");
  const serverRoot = resolve(root, "packages/ui/.svelte-kit/output/server");
  const immutable = join(clientRoot, "_app/immutable");
  const manifestPath = join(clientRoot, ".vite/manifest.json");
  const routeNodeName = process.env.RED_REQUEST_PERF_ROUTE_NODE;
  const clientJs = jsSummary(immutable);
  const serverJs = jsSummary(serverRoot);

  let routeInitial = null;
  let manifest = null;
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const routeKey = routeEntryKey(manifest, routeNodeName);
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
    routeConfig: routeConfigSummary(),
    pluginTimings: pluginTimingSummary(buildOutput),
    largestClientJs: clientJs.files.slice(0, 10),
    routeInitial,
    serverOutput: {
      exists: existsSync(serverRoot),
      jsFiles: serverJs.count,
      bytes: serverJs.bytes,
      gzipBytes: serverJs.gzipBytes,
      largestServerJs: serverJs.files.slice(0, 10),
    },
    uiPrimitives: uiPrimitiveSummary(manifest, serverJs.files, clientJs.files),
  };
}

function pluginTimingSummary(output) {
  const samples = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+(.+?)\s+\((\d+)%\)\s*$/);
    if (match) {
      samples.push({ plugin: match[1], percent: Number(match[2]) });
    }
  }
  const byPlugin = new Map();
  for (const sample of samples) {
    const current = byPlugin.get(sample.plugin) ?? {
      plugin: sample.plugin,
      maxPercent: 0,
      samples: 0,
    };
    current.maxPercent = Math.max(current.maxPercent, sample.percent);
    current.samples += 1;
    byPlugin.set(sample.plugin, current);
  }
  return {
    samples,
    byPlugin: [...byPlugin.values()].sort(
      (a, b) => b.maxPercent - a.maxPercent
    ),
  };
}

function routeEntryKey(manifest, preferredName) {
  const entries = Object.entries(manifest);
  if (preferredName) {
    const preferred = entries.find(([, entry]) => entry.name === preferredName);
    if (preferred) return preferred[0];
  }
  const routeEntries = entries
    .filter(([, entry]) => /^nodes\/\d+$/.test(entry.name ?? ""))
    .sort(
      ([, a], [, b]) =>
        Number(a.name.split("/")[1]) - Number(b.name.split("/")[1])
    );
  return routeEntries.at(-1)?.[0] ?? null;
}

function bitsUiImportSummary() {
  const uiRoot = resolve(root, "packages/ui/src/lib/components/ui");
  const byPrimitive = new Map();
  if (!existsSync(uiRoot)) return [];
  for (const path of walkFiles(uiRoot).filter((file) =>
    file.endsWith(".svelte")
  )) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(
      /import\s+(?:type\s+)?\{\s*([^}]+)\}\s+from\s+"bits-ui"/g
    )) {
      for (const item of match[1].split(",")) {
        const primitive = item
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (!primitive) continue;
        const current = byPrimitive.get(primitive) ?? [];
        current.push(rel(path));
        byPrimitive.set(primitive, current);
      }
    }
  }
  return [...byPrimitive.entries()]
    .map(([primitive, files]) => ({
      primitive,
      files: [...new Set(files)].sort(),
      count: new Set(files).size,
    }))
    .sort(
      (a, b) => b.count - a.count || a.primitive.localeCompare(b.primitive)
    );
}

function manifestEntrySummary(manifest, term, clientFiles) {
  if (!manifest) return [];
  const lowerTerm = term.toLowerCase();
  return Object.entries(manifest)
    .filter(([key, entry]) =>
      [key, entry.name, entry.src, entry.file]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(lowerTerm))
    )
    .map(([key, entry]) => {
      const clientFile = clientFiles.find(
        (file) => entry.file && file.path.endsWith(entry.file)
      );
      return {
        key,
        name: entry.name ?? null,
        file: entry.file ?? null,
        bytes: clientFile?.bytes ?? null,
        gzipBytes: clientFile?.gzipBytes ?? null,
        imports: entry.imports?.length ?? 0,
        dynamicImports: entry.dynamicImports?.length ?? 0,
      };
    });
}

function fileTermSummary(files, term) {
  const lowerTerm = term.toLowerCase();
  return files.filter((file) => file.path.toLowerCase().includes(lowerTerm));
}

function uiPrimitiveSummary(manifest, serverFiles, clientFiles) {
  const targets = [
    "Select",
    "Modal",
    "CommandPalette",
    "dropdown-menu",
    "tooltip",
  ];
  return {
    bitsUiImports: bitsUiImportSummary(),
    chunks: targets.map((target) => ({
      target,
      clientManifestEntries: manifestEntrySummary(
        manifest,
        target,
        clientFiles
      ),
      serverFiles: fileTermSummary(serverFiles, target),
    })),
  };
}

async function measureUi(records) {
  pushRecord(
    records,
    await run("core build", "pnpm", [
      "--filter",
      "@reddb-io/request-core",
      "build",
    ])
  );
  const uiBuild = pushRecord(
    records,
    await run(
      "ui build",
      "pnpm",
      ["--filter", "@reddb-io/request-ui", "build"],
      {
        captureOutput: true,
      }
    )
  );
  return bundleSummary(uiBuild.output);
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
  const runId = nowId();
  for (const variant of variants) {
    const targetDir = resolve(outDir, `cargo-target-${runId}-${variant.name}`);
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
    pushRecord(records, record);
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
      `Largest client JS: ${kib(largest.bytes)} KiB (${kib(largest.gzipBytes)} KiB gzip) ${largest.path}`
    );
  }
  if (result.ui?.routeInitial) {
    const route = result.ui.routeInitial;
    console.log(
      `Route initial JS: ${kib(route.bytes)} KiB (${kib(route.gzipBytes)} KiB gzip), ${route.files} files`
    );
  }
  if (result.ui?.serverOutput?.exists) {
    const server = result.ui.serverOutput;
    console.log(
      `SvelteKit server JS: ${kib(server.bytes)} KiB (${kib(server.gzipBytes)} KiB gzip), ${server.jsFiles} files, ssrDisabled=${result.ui.routeConfig.ssrFalse}`
    );
  }
  if (result.ui?.pluginTimings?.byPlugin?.[0]) {
    const plugin = result.ui.pluginTimings.byPlugin[0];
    console.log(
      `Top build plugin timing: ${plugin.plugin} (${plugin.maxPercent}% max across ${plugin.samples} samples)`
    );
  }
  if (result.ui?.uiPrimitives?.chunks?.length) {
    const chunks = result.ui.uiPrimitives.chunks
      .map((item) => {
        const clientBytes = item.clientManifestEntries.reduce((sum, entry) => {
          return sum + (entry.bytes ?? 0);
        }, 0);
        const serverBytes = item.serverFiles.reduce(
          (sum, file) => sum + file.bytes,
          0
        );
        return `${item.target}: clientKnown=${kib(clientBytes)} KiB server=${kib(serverBytes)} KiB`;
      })
      .join("; ");
    console.log(`UI primitive chunks: ${chunks}`);
  }
} catch (error) {
  if (error.record) records.push(commandRecord(error.record));
  const output = resolve(outDir, `perf-build-failed-${nowId()}.json`);
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.error(error instanceof Error ? error.message : error);
  console.error(`Wrote ${rel(output)}`);
  process.exit(1);
}
