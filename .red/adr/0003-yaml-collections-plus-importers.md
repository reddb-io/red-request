# 0003 — Collections are native YAML on disk; other formats are importers

**Status:** accepted · 2026-06-19

## Context

Bruno's core principle is plain-text, git-friendly collections (no mandatory cloud). We
need an on-disk format. recker has no serializable collection format of its own, so we must
define one. Candidates: reuse Bruno's `.bru` DSL, store Postman-style JSON, or a native
YAML schema.

## Decision

Native **YAML**, one request per file, validated by `@red-requester/core` schemas:

```
<collection>/collection.yaml
<collection>/requests/<id>.yaml
<collection>/environments/<name>.yaml
```

Bruno (`.bru`), Postman, Insomnia, OpenAPI, curl and HAR are **importers/exporters**
(phase F5), not the native format.

## Consequences

- Clean git diffs (one request = one small file); readable and hand-editable.
- We control the schema and map it directly to recker's request options.
- We are not coupled to Bruno's DSL or roadmap.
- Interop is deferred to F5; until then, migration from other tools isn't available.
