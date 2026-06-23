## Development workflow

- Work in an isolated worktree; do not change the primary checkout's branch for task work.
- Commit the worktree, push the branch early, then run `/ship` to open or reuse a PR.
- Let `/ship` monitor checks and reviews, then either merge the PR or park the issue/PR for `/hitl`.
- The agent never switches the primary checkout's branch; only the user does. The `dev.lock.primary-branch` flag in `.red/config.yaml` is the kill-switch for the primary-branch guard.

## Performance discipline

- Treat performance as product quality, especially on startup, project load, request selection, response rendering/search, runner loops, and RedDB history/store access.
- Before changing a hot path, check for repeated full-list scans, eager `JSON.parse`/`JSON.stringify`, large `structuredClone` calls, whole-collection reads where a subset would do, and rendering thousands of nodes or lines at once.
- Prefer indexed lookups, single-pass loops, lazy or partial rendering, storage-side filtering, and realistic fixtures over speculative rewrites.
- Add or update lightweight perf workloads when touching hot paths. Benchmarks can start non-blocking, but visible regressions should become hard to ignore.
- For Rust/Tauri performance work, profile release builds before invasive changes; keep `cargo fmt`, Clippy, frame-pointer/debug-info profiling, LTO, allocator, and PGO decisions tied to evidence.

## Agent skills

### Issue tracker

Issues and PRDs live on GitHub Issues (`reddb-io/red-request`), driven via the `gh` CLI. See `.red/agents/issue-tracker.md`.

### Triage labels

Canonical triage vocabulary (`needs-triage`, `ready-for-agent`, `ready-for-human`, `blocked:dependency`, `wontfix`, …) — each role string equals its name. See `.red/agents/triage-labels.md`.

### Domain docs

Single-context: one `.red/CONTEXT.md` + `.red/adr/` at the repo root. See `.red/agents/domain.md`.
