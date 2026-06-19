# 0007 — Secrets are sealed (AES-256-GCM) in the .rdb; master key in the keychain

**Status:** accepted · 2026-06-19 · supersedes [ADR-0004](0004-secrets-in-keychain-yaml-references-only.md)

## Context

With RedDB as the store (ADR-0006), the user wants "all content" — including secrets — in
the `.rdb`. But the shipped RedDB (0.1.5) does **not** encrypt data pages at rest (the
`--vault` flag only encrypts the auth vault). Writing raw secret values into the `.rdb`
would put plaintext credentials on disk — worse than ADR-0004's keychain.

## Decision

Store secret **values as ciphertext** in the `.rdb`, sealed app-side:

- A 256-bit **master key** is generated once and stored in the OS keychain (`keyring`),
  never entering the webview.
- Rust commands `secret_seal(plaintext) → {iv,ct}` and `secret_open({iv,ct}) → plaintext`
  do AES-256-GCM (random 96-bit nonce per value).
- A stored environment holds `secrets: { NAME: {iv,ct} }`. The `.rdb` only ever contains
  ciphertext; the keychain holds **one** key, not N secrets.
- YAML export writes only secret **names** (`secretRefs`), never values or ciphertext.

## Consequences

- "Everything in the `.rdb`" holds — as ciphertext — with no plaintext secret on disk.
- One keychain entry to manage/rotate instead of one per secret.
- **Known limitation (carried from ADR-0004):** at send time the UI calls `secret_open`
  to build the variable map, so plaintext secrets briefly transit the webview. Hardening
  follow-up: have the Rust bridge inject opened secrets into `http.send` params so they
  never reach the webview.
- Losing the keychain entry makes existing sealed secrets unrecoverable (re-enter them).
