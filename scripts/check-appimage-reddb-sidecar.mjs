#!/usr/bin/env node
// Validate the RedDB sidecar path used by Linux AppImages.
//
// AppImage tooling can mutate executable ELF sidecars under usr/bin. The app must
// therefore ship an immutable gzip resource, extract it at runtime, and execute
// that cache copy. This script checks the release artifact contains that resource
// and that the decompressed binary can run.
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

const [appimageArg, expectedVersionArg] = process.argv.slice(2);
if (!appimageArg) {
  console.error(
    "usage: check-appimage-reddb-sidecar.mjs <AppImage> [expected-version]"
  );
  process.exit(2);
}

const appimage = resolve(appimageArg);
const work = mkdtempSync(join(tmpdir(), "red-request-appimage-sidecar-"));

function walk(dir, hits = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, hits);
    else hits.push(path);
  }
  return hits;
}

try {
  const extracted = spawnSync(appimage, ["--appimage-extract"], {
    cwd: work,
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
    encoding: "utf8",
  });
  if (extracted.error) throw extracted.error;
  if (extracted.status !== 0) {
    console.error(extracted.stdout);
    console.error(extracted.stderr);
    throw new Error(
      `${basename(appimage)} --appimage-extract exited ${extracted.status}`
    );
  }

  const root = join(work, "squashfs-root");
  const resources = walk(root).filter((path) => /\/red-[^/]+\.gz$/.test(path));
  if (resources.length === 0) {
    throw new Error(
      "AppImage does not contain an immutable red-<target>.gz resource"
    );
  }
  if (resources.length > 1) {
    throw new Error(
      `AppImage contains multiple RedDB resources: ${resources.join(", ")}`
    );
  }

  const red = join(work, "red");
  writeFileSync(red, gunzipSync(readFileSync(resources[0])));
  chmodSync(red, 0o755);

  const version = spawnSync(red, ["--version"], {
    cwd: work,
    env: { ...process.env, LD_LIBRARY_PATH: "", LD_PRELOAD: "" },
    encoding: "utf8",
  });
  if (version.error) throw version.error;
  if (version.status !== 0) {
    console.error(version.stdout);
    console.error(version.stderr);
    throw new Error(`decompressed RedDB sidecar exited ${version.status}`);
  }

  const output = version.stdout.trim();
  if (!/^reddb\s+\d+\.\d+\.\d+/.test(output)) {
    throw new Error(
      `unexpected RedDB version output: ${JSON.stringify(output)}`
    );
  }
  if (expectedVersionArg) {
    const expected = expectedVersionArg.replace(/^v/, "");
    if (!output.endsWith(expected)) {
      throw new Error(`expected RedDB ${expected}, got ${output}`);
    }
  }

  console.log(`✔ ${basename(appimage)} immutable RedDB resource: ${output}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
