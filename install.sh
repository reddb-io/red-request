#!/usr/bin/env bash
#
# Red Request — one-line installer / auto-upgrader.
#
#   curl -fsSL https://raw.githubusercontent.com/reddb-io/red-request/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --version v0.1.0
#
# What it does:
#   • detects your OS/architecture
#   • resolves the latest release (or --version <tag>)
#   • downloads the single-file app binary  (Linux: AppImage · Windows: .exe · macOS: .dmg)
#   • verifies its sha256 against the release checksums.txt
#   • drops it on your PATH at ~/.local/bin/red-request  (+ an `rr` shortcut)
#   • if a copy is already installed, auto-upgrades in place (and no-ops when current)
#
# Linux is fully self-service (AppImage = one file, no apt, no sudo, no deps to resolve).
# macOS/Windows ship GUI installers; the script verifies + hands you the file to open.
#
# Remove everything with the matching uninstall.sh.
set -euo pipefail

REPO="reddb-io/red-request"
BIN_NAME="red-request"
SHORTCUT="rr"
INSTALL_DIR="${RED_REQUEST_INSTALL_DIR:-${INSTALL_DIR:-$HOME/.local/bin}}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/red-request"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
VERSION=""
FORCE=0
MODIFY_PATH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:?}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --no-modify-path) MODIFY_PATH=0; shift ;;
    -h|--help)
      cat <<EOF
Red Request installer

Usage: install.sh [OPTIONS]
  --version <vX.Y.Z>     Install/upgrade to a specific release (default: latest)
  --install-dir <path>   Where to put the binary (default: ~/.local/bin)
  --force                Reinstall even if already on the latest version
  --no-modify-path       Don't touch your shell rc; just print the PATH hint
  -h, --help             This help

Env: RED_REQUEST_INSTALL_DIR overrides --install-dir.
EOF
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── tiny ui ────────────────────────────────────────────────────────────────
say()  { printf '→ %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
err()  { printf '✗ %s\n' "$*" >&2; exit 1; }

# ── platform ──────────────────────────────────────────────────────────────
detect_platform() {
  local os arch
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in
    Linux*)               OS="linux" ;;
    Darwin*)              OS="darwin" ;;
    MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
    *) err "Unsupported OS: $os" ;;
  esac
  case "$arch" in
    x86_64|amd64)   ARCH="x86_64" ;;
    aarch64|arm64)  ARCH="aarch64" ;;
    *) err "Unsupported architecture: $arch" ;;
  esac
}

# Filename of the single-file asset for this platform (must match release.yml).
asset_name() {
  case "$OS" in
    linux)   printf '%s-linux-%s.AppImage' "$BIN_NAME" "$ARCH" ;;
    darwin)  printf '%s-darwin-%s.dmg' "$BIN_NAME" "$ARCH" ;;
    windows) printf '%s-windows-%s-setup.exe' "$BIN_NAME" "$ARCH" ;;
  esac
}

# ── network ────────────────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

download() { # url dest
  if have curl; then curl -fSL --retry 3 -o "$2" "$1"
  elif have wget; then wget -qO "$2" "$1"
  else err "need curl or wget"; fi
}

# Resolve the release tag without hitting the rate-limited JSON API: GitHub's
# /releases/latest endpoint 302-redirects to /releases/tag/<tag>, so we read the
# final URL. For an explicit --version we trust the tag as given.
resolve_tag() {
  if [[ -n "$VERSION" ]]; then printf '%s' "$VERSION"; return; fi
  local url=""
  if have curl; then
    url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
            "https://github.com/$REPO/releases/latest" 2>/dev/null || true)"
  elif have wget; then
    url="$(wget -q -S --max-redirect=10 -O /dev/null \
            "https://github.com/$REPO/releases/latest" 2>&1 \
            | awk '/^[[:space:]]*Location:/ {print $2}' | tail -1 || true)"
  fi
  [[ "$url" == *"/releases/tag/"* ]] || return 1
  printf '%s' "${url##*/releases/tag/}"
}

asset_url()    { printf 'https://github.com/%s/releases/download/%s/%s' "$REPO" "$1" "$2"; }
checksum_url() { printf 'https://github.com/%s/releases/download/%s/checksums.txt' "$REPO" "$1"; }

sha256_of() { # file -> hex
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif have shasum;   then shasum -a 256 "$1" | awk '{print $1}'
  else return 1; fi
}

# Verify $1 (file) against the checksums.txt body in $2; each line is "<hex>  <name>".
verify_sha256() { # file checksums_text asset_name
  local want got
  want="$(printf '%s\n' "$2" | awk -v f="$3" '$2==f || $2=="*"f {print $1; exit}')"
  [[ -n "$want" ]] || { warn "no checksum for $3 in checksums.txt — skipping verify"; return 0; }
  got="$(sha256_of "$1")" || { warn "no sha256 tool found — skipping verify"; return 0; }
  [[ "$got" == "$want" ]] || err "checksum mismatch for $3
   expected $want
   got      $got"
  ok "sha256 verified"
}

# ── path wiring ────────────────────────────────────────────────────────────
on_path() { case ":$PATH:" in *":$INSTALL_DIR:"*) return 0 ;; *) return 1 ;; esac; }

rc_file() {
  case "${SHELL##*/}" in
    zsh)  printf '%s' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) [[ -f "$HOME/.bashrc" ]] && printf '%s' "$HOME/.bashrc" || printf '%s' "$HOME/.profile" ;;
    *)    printf '%s' "$HOME/.profile" ;;
  esac
}

ensure_path() {
  on_path && return 0
  if [[ "$MODIFY_PATH" == "0" ]]; then
    warn "$INSTALL_DIR is not on your PATH — add: export PATH=\"$INSTALL_DIR:\$PATH\""
    return 0
  fi
  local rc; rc="$(rc_file)"
  if [[ -f "$rc" ]] && grep -q '# >>> red-request >>>' "$rc"; then return 0; fi
  {
    printf '\n# >>> red-request >>>\n'
    printf 'export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    printf '# <<< red-request <<<\n'
  } >> "$rc"
  ok "added $INSTALL_DIR to PATH in $rc — open a new shell or: source $rc"
}

# ── desktop entry (best-effort, Linux only) ────────────────────────────────
write_desktop_entry() {
  [[ "$OS" == "linux" ]] || return 0
  mkdir -p "$DESKTOP_DIR" 2>/dev/null || return 0
  cat > "$DESKTOP_DIR/red-request.desktop" <<EOF || return 0
[Desktop Entry]
Type=Application
Name=Red Request
Comment=Open-source API client
Exec=$INSTALL_DIR/$BIN_NAME %U
Terminal=false
Categories=Development;Utility;
EOF
  have update-desktop-database && update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
}

installed_version() { [[ -f "$DATA_DIR/version" ]] && cat "$DATA_DIR/version" || printf ''; }

# ── linux: the full magic path ─────────────────────────────────────────────
install_linux() {
  local tag cur asset url ck_text tmp
  tag="$(resolve_tag)" || err "could not resolve the latest release tag"
  asset="$(asset_name)"
  cur="$(installed_version)"

  if [[ -n "$cur" && "$cur" == "$tag" && "$FORCE" != "1" ]]; then
    ok "Red Request $cur is already the latest — nothing to do. (--force to reinstall)"
    return 0
  fi

  say "${cur:+upgrading $cur → }${cur:-installing }$tag ($OS/$ARCH)"
  url="$(asset_url "$tag" "$asset")"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/red-request.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN

  say "downloading $asset"
  download "$url" "$tmp/$asset" || err "download failed — is $asset published in $tag? ($url)"

  ck_text="$(download "$(checksum_url "$tag")" /dev/stdout 2>/dev/null || true)"
  if [[ -n "$ck_text" ]]; then verify_sha256 "$tmp/$asset" "$ck_text" "$asset"
  else warn "no checksums.txt in $tag — skipping verify"; fi

  mkdir -p "$INSTALL_DIR" "$DATA_DIR"
  chmod +x "$tmp/$asset"
  # replace via temp name so an in-use binary is swapped, not truncated.
  mv -f "$tmp/$asset" "$INSTALL_DIR/$BIN_NAME.new"
  mv -f "$INSTALL_DIR/$BIN_NAME.new" "$INSTALL_DIR/$BIN_NAME"
  ln -sf "$BIN_NAME" "$INSTALL_DIR/$SHORTCUT"
  printf '%s\n' "$tag" > "$DATA_DIR/version"
  write_desktop_entry
  ensure_path

  ok "${cur:+upgraded to }Red Request $tag → $INSTALL_DIR/$BIN_NAME"
  say "run it:  $BIN_NAME        (or  $SHORTCUT .  to open the current folder as a project)"
}

# ── macOS / Windows: verify + hand off the GUI installer ───────────────────
install_gui() {
  local tag asset url
  tag="$(resolve_tag)" || err "could not resolve the latest release tag"
  asset="$(asset_name)"
  url="$(asset_url "$tag" "$asset")"
  say "Red Request $tag ships a GUI installer for $OS."
  printf '   download & open:  %s\n' "$url"
  printf '   checksums:        %s\n' "$(checksum_url "$tag")"
  [[ "$OS" == "darwin" ]] && say "first launch: right-click the app → Open (unsigned build)."
  return 0
}

main() {
  detect_platform
  case "$OS" in
    linux)          install_linux ;;
    darwin|windows) install_gui ;;
  esac
}

main
