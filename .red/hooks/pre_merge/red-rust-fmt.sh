#!/usr/bin/env bash
set -euo pipefail

# pre_merge gate — mirrors CI's `rust-fmt` job (.github/workflows/ci.yml).
# Self-guarding: this runs on EVERY AFK iteration, so it must no-op cleanly when
# the Rust toolchain or the Tauri crate is absent, otherwise a JS-only change
# would be blocked from merging on a host without cargo/rustfmt.

# No cargo on this host → nothing to check; let the merge proceed.
command -v cargo >/dev/null 2>&1 || { echo "red-rust-fmt: cargo not installed — skipping"; exit 0; }

# Run from the repo root (AFK invokes hooks with the worktree as CWD).
crate_dir="apps/desktop/src-tauri"
[ -d "$crate_dir" ] || { echo "red-rust-fmt: $crate_dir not found — skipping"; exit 0; }

echo "red-rust-fmt: cargo fmt --all --check in $crate_dir"
cd "$crate_dir"
cargo fmt --all --check
