# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, report privately via
[GitHub Security Advisories](https://github.com/reddb-io/red-request/security/advisories/new),
or email **security@reddb.io**. We aim to acknowledge within 72 hours.

## What to include

- Affected version (Help → About, or the release tag) and OS.
- A clear description and, ideally, a minimal reproduction.
- Impact assessment if you have one.

## Scope notes

- **Secrets** are sealed with AES-256-GCM; the master key lives in the OS keychain. Plain
  variables and KV data in the embedded `.rdb` are **not** cryptographically encrypted at
  rest — treat the `.rdb` as sensitive and don't commit it. YAML export never contains
  secret values.
- Desktop builds are currently **unsigned**. Verify downloads against the release `.sha256`
  sidecars where present.
