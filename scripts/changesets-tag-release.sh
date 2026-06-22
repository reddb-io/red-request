#!/usr/bin/env bash
#
# changesets-tag-release.sh — the `publish` step of `changesets/action@v1`
# (see .github/workflows/changesets.yml).
#
# The action runs this only AFTER all pending changesets are consumed — i.e.
# when the "Version Packages" PR is merged and the version-bump commit just
# landed on main. We:
#
#   1. Read the canonical version from the root package.json (the
#      `pnpm release:version` step already propagated it into tauri.conf.json
#      via scripts/sync-desktop-version.mjs).
#   2. Validate it's a clean semver.
#   3. Tag and push `v<version>` — that tag push triggers release.yml, which
#      builds the desktop bundles and creates the GitHub Release.
#
# Idempotent: if the tag already exists locally or on origin we exit 0.
set -euo pipefail

# Canonical version = the fixed core/engine/ui group that changesets bumps (the root
# package.json is private and NOT bumped). sync-desktop-version.mjs uses the same source.
VERSION="$(node -e 'process.stdout.write(require("./packages/core/package.json").version)')"

if [[ -z "$VERSION" ]]; then
  echo "changesets-tag-release: packages/core/package.json has no version" >&2
  exit 1
fi
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._-]+)?$ ]]; then
  echo "changesets-tag-release: version '$VERSION' is not a valid semver" >&2
  exit 1
fi

TAG="v$VERSION"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "changesets-tag-release: tag $TAG already exists locally — skipping create"
else
  git tag -a "$TAG" -m "Release $TAG"
fi

if git ls-remote --tags origin "refs/tags/$TAG" | grep -q "$TAG"; then
  echo "changesets-tag-release: tag $TAG already on origin — skipping push"
else
  git push origin "refs/tags/$TAG"
  echo "changesets-tag-release: pushed $TAG"
fi

# Trigger release.yml. A tag pushed with GITHUB_TOKEN does NOT trigger workflows, so we
# dispatch it explicitly via workflow_dispatch — which GITHUB_TOKEN *is* allowed to do
# (with `actions: write`). No RELEASE_PAT required. Locally (no gh/token) we just stop here;
# a human-pushed tag triggers release.yml on its own.
if command -v gh >/dev/null 2>&1 && [[ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]]; then
  echo "changesets-tag-release: dispatching release.yml for $TAG"
  gh workflow run release.yml --ref main -f tag="$TAG"
else
  echo "changesets-tag-release: gh/token unavailable — release.yml will run on the tag push"
fi
