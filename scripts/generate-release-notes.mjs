#!/usr/bin/env node
import { readFileSync } from "node:fs";

const repo = process.env.GITHUB_REPOSITORY || "reddb-io/red-request";
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const tag = process.argv[2];

if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) {
  console.error("usage: generate-release-notes.mjs vX.Y.Z");
  process.exit(2);
}

const apiBase = `https://api.github.com/repos/${repo}`;
const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

async function gh(path) {
  const res = await fetch(`${apiBase}${path}`, { headers });
  if (!res.ok)
    throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

function semver(value) {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(value);
  if (!match) return null;
  return match.slice(1, 4).map(Number);
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function previousTag(releases, currentTag) {
  const current = semver(currentTag);
  if (!current) return null;
  return releases
    .map((release) => release.tag_name)
    .filter((releaseTag) => {
      const parsed = semver(releaseTag);
      return parsed && compareSemver(parsed, current) < 0;
    })
    .sort((a, b) => compareSemver(semver(b), semver(a)))[0];
}

function cleanSubject(message) {
  return message.split("\n")[0]?.trim() || "";
}

function parseConventional(subject) {
  const match =
    /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<text>.+)$/.exec(
      subject
    );
  if (!match?.groups) return null;
  return {
    type: match.groups.type,
    scope: match.groups.scope || "",
    breaking: Boolean(match.groups.breaking),
    text: match.groups.text.replace(/\s+\(#\d+\)$/, ""),
    pr: /\(#(?<pr>\d+)\)$/.exec(match.groups.text)?.groups?.pr,
  };
}

const groups = [
  {
    title: "🚀 Features",
    types: new Set(["feat"]),
  },
  {
    title: "🐛 Bug fixes",
    types: new Set(["fix", "perf"]),
  },
  {
    title: "🏗 Build, CI & release",
    types: new Set(["build", "ci", "chore"]),
  },
  {
    title: "📚 Documentation",
    types: new Set(["docs"]),
  },
  {
    title: "🧪 Tests",
    types: new Set(["test"]),
  },
  {
    title: "🧹 Maintenance",
    types: new Set(["refactor", "style", "revert"]),
  },
];

function groupedCommits(commits) {
  const byTitle = new Map(groups.map((group) => [group.title, []]));
  const other = [];
  for (const commit of commits) {
    const subject = cleanSubject(commit.commit.message);
    if (!subject || /^chore\(release\):/.test(subject)) continue;
    const parsed = parseConventional(subject);
    const item = parsed
      ? {
          ...parsed,
          sha: commit.sha.slice(0, 7),
          url: commit.html_url,
        }
      : {
          type: "other",
          scope: "",
          breaking: false,
          text: subject,
          pr: "",
          sha: commit.sha.slice(0, 7),
          url: commit.html_url,
        };
    const group = groups.find((candidate) => candidate.types.has(item.type));
    if (group) byTitle.get(group.title).push(item);
    else other.push(item);
  }
  if (other.length > 0) byTitle.set("Other changes", other);
  return [...byTitle.entries()].filter(([, items]) => items.length > 0);
}

function commitLine(item) {
  const scope = item.scope ? `**${item.scope}**: ` : "";
  const breaking = item.breaking ? "**BREAKING** " : "";
  const pr = item.pr ? ` (#${item.pr})` : "";
  return `- ${breaking}${scope}${item.text}${pr} ([${item.sha}](${item.url}))`;
}

function stableAssetRows(assets, releaseTag) {
  const names = new Set(assets.map((asset) => asset.name));
  const row = (platform, asset, notes) =>
    names.has(asset) ? `| ${platform} | \`${asset}\` | ${notes} |` : null;
  return [
    row(
      "Linux x86_64",
      "red-request-linux-x86_64.AppImage",
      "Portable AppImage"
    ),
    row(
      "Linux x86_64",
      "red-request-linux-x86_64.deb",
      "Debian/Ubuntu package"
    ),
    row(
      "Linux aarch64",
      "red-request-linux-aarch64.AppImage",
      "Portable AppImage"
    ),
    row(
      "Linux aarch64",
      "red-request-linux-aarch64.deb",
      "Debian/Ubuntu package"
    ),
    row(
      "macOS Apple Silicon",
      "red-request-darwin-aarch64.dmg",
      "DMG installer"
    ),
    row(
      "Windows x86_64",
      "red-request-windows-x86_64-setup.exe",
      "NSIS setup installer"
    ),
    row("All platforms", "checksums.txt", "SHA-256 manifest"),
    row("All platforms", "SHA256SUMS", "SHA-256 manifest alias"),
    row("All platforms", "artifact-sizes.md", "Release size evidence"),
  ]
    .filter(Boolean)
    .join("\n");
}

function readVersion() {
  try {
    return JSON.parse(readFileSync("package.json", "utf8")).version;
  } catch {
    return tag.replace(/^v/, "");
  }
}

const releases = await gh("/releases?per_page=100");
const release = await gh(`/releases/tags/${encodeURIComponent(tag)}`);
const prev = previousTag(releases, tag);
const compare = prev ? await gh(`/compare/${prev}...${tag}`) : { commits: [] };
const sections = groupedCommits(compare.commits ?? []);
const version = readVersion();
const redDbVersion = process.env.REDDB_VERSION || "the pinned RedDB sidecar";
const compareUrl = prev
  ? `https://github.com/${repo}/compare/${prev}...${tag}`
  : `https://github.com/${repo}/releases/tag/${tag}`;
const assets = release.assets ?? [];
const assetNames = new Set(assets.map((asset) => asset.name));

const out = [];
out.push(`# Red Request ${tag}`);
out.push("");
out.push("## What's in this release");
out.push("");
if (sections.length === 0) {
  out.push(
    "- No conventional user-facing commits were found for this release window."
  );
} else {
  for (const [title, items] of sections) {
    out.push(`### ${title}`);
    out.push("");
    out.push(...items.map(commitLine));
    out.push("");
  }
}
out.push(`**Full Changelog**: ${compareUrl}`);
out.push("");
out.push("---");
out.push("");
out.push("## Upgrade Notes");
out.push("");
out.push(
  "- This is intended to be a standard same-major desktop upgrade unless a breaking change is listed above."
);
out.push(
  "- Local `.rdb` project files remain single-writer desktop files; shared sync queues are used only for remote/container RedDB project sources."
);
out.push(
  `- The packaged desktop app and workspace packages are versioned together as \`${version}\`.`
);
out.push("");
out.push("## Compatibility");
out.push("");
out.push(
  `- Bundles embed RedDB sidecar \`${redDbVersion}\` for local project storage.`
);
out.push("- Linux x86_64 and aarch64 are published as `.AppImage` and `.deb`.");
out.push("- macOS is currently Apple Silicon (`aarch64`) only.");
out.push("- Windows is currently x86_64 only.");
out.push(
  "- Remote/container RedDB sources keep fanout queue sync enabled; local file projects do not create or poll the sync queue."
);
out.push("");
out.push("## Installation");
out.push("");
out.push("**Linux / macOS auto-installer:**");
out.push("```bash");
out.push(
  "curl -fsSL https://raw.githubusercontent.com/reddb-io/red-request/main/install.sh | bash"
);
out.push("```");
out.push("");
out.push("**Prebuilt desktop assets:**");
out.push("");
out.push("| Platform | Asset | Notes |");
out.push("| --- | --- | --- |");
out.push(stableAssetRows(assets, tag));
out.push("");
out.push("## Verification");
out.push("");
if (assetNames.has("SHA256SUMS")) {
  out.push(
    "This release publishes `checksums.txt` and `SHA256SUMS`; both contain the same SHA-256 manifest for the stable installer asset names."
  );
} else {
  out.push(
    "This release publishes `checksums.txt` with SHA-256 hashes for the stable installer asset names. Newer releases also publish the standard `SHA256SUMS` alias."
  );
}
out.push("");
out.push("```bash");
out.push(
  `curl -fsSLO https://github.com/${repo}/releases/download/${tag}/${
    assetNames.has("SHA256SUMS") ? "SHA256SUMS" : "checksums.txt"
  }`
);
out.push(
  `curl -fsSLO https://github.com/${repo}/releases/download/${tag}/red-request-linux-x86_64.AppImage`
);
out.push(
  `grep '  red-request-linux-x86_64.AppImage$' ${
    assetNames.has("SHA256SUMS") ? "SHA256SUMS" : "checksums.txt"
  } | sha256sum -c -`
);
out.push("```");
out.push("");
out.push("## Provenance Status");
out.push("");
out.push(
  "- SHA-256 manifests are published for the stable installer assets in this release."
);
out.push(
  "- Code signing, GitHub artifact attestations, SBOMs, and Cosign verification are not published for Red Request yet."
);
out.push(
  "- macOS and Windows builds are unsigned for now: macOS may require right-click -> Open; Windows may require SmartScreen's More info -> Run anyway."
);
out.push("");
out.push("## Release Assets");
out.push("");
out.push(
  assetNames.has("SHA256SUMS")
    ? "- `checksums.txt` / `SHA256SUMS`: aggregate SHA-256 manifests for stable installer assets."
    : "- `checksums.txt`: aggregate SHA-256 manifest for stable installer assets."
);
out.push(
  "- `artifact-sizes.md`: size evidence for the stable installer assets."
);
out.push(
  "- `red-request-*`: stable, version-free asset names used by the installer."
);
out.push(
  "- `Red.Request_*`: native Tauri-generated bundle names retained for desktop updater compatibility."
);

console.log(out.join("\n"));
