# 0005 — White-label via a single brand config

**Status:** accepted · 2026-06-19

## Context

The product must be rebrandable without touching code. Brand identity is otherwise scattered
across the Tauri config (product name, identifier, deep-link scheme), CSS theme tokens, and
runtime strings (about box, header, links).

## Decision

One source of truth: **`brand/brand.config.json`**. `scripts/sync-brand.mjs` stamps it into:

- `apps/desktop/src-tauri/tauri.conf.json` — productName, identifier, window title,
  deep-link scheme, descriptions.
- `packages/ui/src/lib/brand.generated.css` — the Tailwind v4 `@theme` block (accent + bg
  tokens).
- `packages/ui/src/lib/brand.generated.ts` — runtime constants the UI imports.

The generated files are committed but marked auto-generated. Rebranding = edit one JSON,
swap the logo, run `pnpm brand:sync`.

## Consequences

- Zero hardcoded brand strings/colors in components.
- Brand changes are a single reviewable diff.
- The generated files must be regenerated (and not hand-edited) after a config change;
  `sync-brand` runs as part of `desktop:dev` / `desktop:build`.
