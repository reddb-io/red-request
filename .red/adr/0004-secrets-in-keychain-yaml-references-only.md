# 0004 — Secrets live in the OS keychain; YAML only references them

**Status:** superseded by [ADR-0007](0007-secrets-encrypted-in-rdb-master-key-in-keychain.md) · 2026-06-19

> Superseded: secret _values_ now live (sealed) in the RedDB store, encrypted with a
> master key kept in the keychain. The keychain holds one key, not N secrets. See ADR-0007.

## Context

Collections are meant to be committed to git. Environments hold values like API keys that
must never be committed. We need a place for secret values that is both secure and outside
version control.

## Decision

An environment file stores plain `vars` inline and **`secretRefs` (names only)**. The
secret _value_ lives in the OS keychain (`keyring` crate: macOS Keychain, Windows
Credential Manager, Linux Secret Service), under a brand- and collection-scoped service id
(`<brand.identifier>:<collectionId>`). At dispatch time the UI resolves each `secretRef`
via `keychain_get` and merges it into the variable map (precedence: secret > environment >
collection).

## Consequences

- YAML is safe to commit — no secret material ever touches disk in the repo.
- Secrets are per-machine; sharing a collection shares structure, not credentials.
- **Known limitation:** in the first release the UI reads secret values into webview memory
  to build the variable map. A hardening follow-up can have the Rust bridge inject secrets
  into `engine_call` params so they bypass the webview entirely.
