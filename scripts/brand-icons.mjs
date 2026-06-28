#!/usr/bin/env node
// Regenerate the desktop app icons (icon.ico / icon.icns / PNGs) from the brand's icon
// source, so a white-label build ships with the right launcher/taskbar/installer icon.
//
//   node scripts/brand-icons.mjs
//
// Reads `iconPath` from brand/brand.config.json — a square PNG (≥512px, 1024 ideal). When
// unset, it's a no-op (the committed icons are kept). Tauri's `icon` generator produces a
// proper multi-frame .ico (RC.EXE-compatible) + .icns + the PNG set; we drop the android/ios
// folders it also writes since this is a desktop app.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brand = JSON.parse(
  readFileSync(resolve(root, "brand/brand.config.json"), "utf8")
);

const src = brand.iconPath?.trim();
if (!src) {
  console.log(
    "brand:icons → no iconPath in brand.config.json — keeping existing icons."
  );
  process.exit(0);
}
const srcAbs = resolve(root, src);
if (!existsSync(srcAbs)) {
  console.error(`brand:icons → iconPath not found: ${src}`);
  process.exit(1);
}

console.log(`brand:icons → regenerating app icons from ${src} …`);
execFileSync(
  "pnpm",
  ["--filter", "@reddb-io/request-desktop", "exec", "tauri", "icon", srcAbs],
  { cwd: root, stdio: "inherit" }
);

// Desktop-only: drop the mobile icon sets `tauri icon` also emits.
for (const dir of ["android", "ios"]) {
  rmSync(resolve(root, "apps/desktop/src-tauri/icons", dir), {
    recursive: true,
    force: true,
  });
}
console.log("brand:icons done.");
