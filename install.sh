#!/usr/bin/env bash
#
# Red Request — one-line installer / auto-upgrader.
#
#   curl -fsSL https://raw.githubusercontent.com/reddb-io/red-request/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --version v0.1.0
#   curl -fsSL .../install.sh | bash -s -- --appimage      # single-file AppImage instead
#
# OS- and arch-agnostic: it detects your platform (linux/macOS/windows · x86_64/aarch64) and
# installs the matching release asset, verifying its sha256 against checksums.txt.
#   • Linux   → the **.deb** by default (system WebKitGTK/glibc, so the bundled engine/red
#               sidecars start cleanly). --appimage for the portable single-file build.
#   • macOS / Windows → downloads + verifies the GUI installer (.dmg / .exe) and hands it to
#               you to open (GUI installers need a click).
# A platform with no published build yet degrades to a clear message. Remove with uninstall.sh.
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
LINUX_FORMAT="deb" # deb (default) | appimage

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:?}"; shift 2 ;;
    --appimage) LINUX_FORMAT="appimage"; shift ;;
    --deb) LINUX_FORMAT="deb"; shift ;;
    --force) FORCE=1; shift ;;
    --no-modify-path) MODIFY_PATH=0; shift ;;
    -h|--help)
      cat <<EOF
Red Request installer

Usage: install.sh [OPTIONS]
  --version <vX.Y.Z>     Install/upgrade to a specific release (default: latest)
  --appimage             Linux: install the single-file AppImage to ~/.local/bin (no sudo)
  --deb                  Linux: install the .deb via apt (default; needs sudo)
  --install-dir <path>   AppImage only — where to put the binary (default: ~/.local/bin)
  --force                Reinstall even if already on the latest version
  --no-modify-path       AppImage only — don't touch your shell rc; just print the PATH hint
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

# Filename of the asset for this platform (must match release.yml's staged names).
asset_name() {
  case "$OS" in
    linux)   [[ "$LINUX_FORMAT" == "appimage" ]] && printf '%s-linux-%s.AppImage' "$BIN_NAME" "$ARCH" || printf '%s-linux-%s.deb' "$BIN_NAME" "$ARCH" ;;
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

# Download $asset for $tag into $dir and verify it. Sets $DL to the file path.
fetch_verified() { # tag asset dir
  local tag="$1" asset="$2" dir="$3" url ck_text
  url="$(asset_url "$tag" "$asset")"
  say "downloading $asset"
  download "$url" "$dir/$asset" || err "download failed — is $asset published in $tag? ($url)"
  ck_text="$(download "$(checksum_url "$tag")" /dev/stdout 2>/dev/null || true)"
  if [[ -n "$ck_text" ]]; then verify_sha256 "$dir/$asset" "$ck_text" "$asset"
  else warn "no checksums.txt in $tag — skipping verify"; fi
  DL="$dir/$asset"
}

# ── linux: .deb via apt (default) ──────────────────────────────────────────
deb_installed_version() { dpkg-query -W -f='${Version}' "$BIN_NAME" 2>/dev/null || printf ''; }

# Absolute path of the binary the .deb installs (e.g. /usr/bin/red-request).
deb_binary_path() { dpkg-query -L "$BIN_NAME" 2>/dev/null | grep -m1 -E "/bin/${BIN_NAME}\$" || true; }

# A prior `--appimage` run drops the 100 MB+ AppImage into ~/.local/bin, which
# usually precedes /usr/bin on PATH and shadows the .deb we just installed — the
# user keeps launching the old AppImage and its bundled-glib errors (e.g.
# "undefined symbol: g_task_set_static_name" from the system gvfs modules).
# Remove our own managed AppImage so /usr/bin/$BIN_NAME wins. Only touches files
# this installer created: $DATA_DIR/version is written solely by install_appimage.
clear_appimage_shadow() {
  [[ -f "$DATA_DIR/version" ]] || return 0
  say "removing prior AppImage install — it shadows the .deb on PATH"
  rm -f "$INSTALL_DIR/$BIN_NAME" "$DATA_DIR/version" "$DESKTOP_DIR/red-request.desktop"
  rmdir "$DATA_DIR" 2>/dev/null || true
  have update-desktop-database && update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
}

# The .deb ships red-request/red/red-request-engine in /usr/bin but no `rr` alias
# (historically AppImage-only). (Re)create it as a symlink in /usr/local/bin — that dir is
# on PATH for every shell (bash/zsh/fish) out of the box, so `rr` just works with no rc-file
# edits, unlike ~/.local/bin. Points at the system binary so `rr` tracks upgrades.
ensure_deb_shortcut() {
  local deb_bin sudo="" dst="/usr/local/bin/$SHORTCUT"
  deb_bin="$(deb_binary_path)"
  [[ -n "$deb_bin" ]] || { warn "could not locate the installed $BIN_NAME binary; skipping $SHORTCUT alias"; return 0; }
  [[ $EUID -ne 0 ]] && have sudo && sudo="sudo"
  $sudo mkdir -p /usr/local/bin && $sudo ln -sf "$deb_bin" "$dst" \
    && ok "linked $SHORTCUT → $deb_bin ($dst)" \
    || warn "could not create the $SHORTCUT symlink in /usr/local/bin"
}

install_deb() {
  have dpkg || err "no dpkg on this system — re-run with --appimage for the portable build"
  local tag asset cur tmp sudo=""
  tag="$(resolve_tag)" || err "could not resolve the latest release tag"
  asset="$(asset_name)"
  cur="$(deb_installed_version)"

  if [[ -n "$cur" && "v$cur" == "$tag" && "$FORCE" != "1" ]]; then
    ok "Red Request $cur (.deb) is already the latest — nothing to do. (--force to reinstall)"
    return 0
  fi

  say "${cur:+upgrading $cur → }${tag} (.deb · $OS/$ARCH)"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/red-request.XXXXXX")"
  trap '[ -n "${tmp:-}" ] && rm -rf "$tmp"' RETURN
  fetch_verified "$tag" "$asset" "$tmp"

  # apt drops privileges to the unprivileged "_apt" user to fetch the local file;
  # mktemp -d is 0700, so _apt can't traverse it and apt warns "Download is
  # performed unsandboxed as root … Permission denied". Widen the path it reads.
  chmod 755 "$tmp" && chmod 644 "$DL"

  [[ $EUID -ne 0 ]] && have sudo && sudo="sudo"
  say "installing via apt (you may be prompted for your password)…"
  if have apt-get; then
    $sudo apt-get install -y ${FORCE:+--reinstall --allow-downgrades} "$DL"
  else
    $sudo dpkg -i "$DL" || { $sudo apt-get -f install -y; $sudo dpkg -i "$DL"; }
  fi
  ok "${cur:+upgraded to }Red Request $tag installed (.deb)"
  clear_appimage_shadow
  ensure_deb_shortcut
  verify_install "$(deb_binary_path)"
  say "launch it from your app menu, or run:  $BIN_NAME   (or  $SHORTCUT .  to open the current folder)"
}

# ── path wiring (AppImage only) ─────────────────────────────────────────────
on_path() { case ":$PATH:" in *":$INSTALL_DIR:"*) return 0 ;; *) return 1 ;; esac; }

rc_file() {
  case "${SHELL##*/}" in
    zsh)  printf '%s' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) [[ -f "$HOME/.bashrc" ]] && printf '%s' "$HOME/.bashrc" || printf '%s' "$HOME/.profile" ;;
    fish) printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" ;;
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
  mkdir -p "$(dirname "$rc")"
  if [[ -f "$rc" ]] && grep -q '# >>> red-request >>>' "$rc"; then return 0; fi
  # fish doesn't read .profile and uses its own PATH syntax — write the right one for the
  # user's shell so the line actually takes effect (a bash `export` in config.fish is inert).
  if [[ "${SHELL##*/}" == "fish" ]]; then
    {
      printf '\n# >>> red-request >>>\n'
      printf 'fish_add_path %s\n' "$INSTALL_DIR"
      printf '# <<< red-request <<<\n'
    } >> "$rc"
  else
    {
      printf '\n# >>> red-request >>>\n'
      printf 'export PATH="%s:$PATH"\n' "$INSTALL_DIR"
      printf '# <<< red-request <<<\n'
    } >> "$rc"
  fi
  ok "added $INSTALL_DIR to PATH in $rc — open a new shell or: source $rc"
}

write_desktop_entry() {
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

appimage_installed_version() { [[ -f "$DATA_DIR/version" ]] && cat "$DATA_DIR/version" || printf ''; }

# ── linux: AppImage single-file (opt-in via --appimage) ─────────────────────
install_appimage() {
  local tag cur asset tmp
  tag="$(resolve_tag)" || err "could not resolve the latest release tag"
  asset="$(asset_name)"
  cur="$(appimage_installed_version)"

  if [[ -n "$cur" && "$cur" == "$tag" && "$FORCE" != "1" ]]; then
    ok "Red Request $cur (AppImage) is already the latest — nothing to do. (--force to reinstall)"
    return 0
  fi

  if [[ -n "$cur" ]]; then say "upgrading $cur → $tag (AppImage · $OS/$ARCH)"; else say "installing $tag (AppImage · $OS/$ARCH)"; fi
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/red-request.XXXXXX")"
  trap '[ -n "${tmp:-}" ] && rm -rf "$tmp"' RETURN
  fetch_verified "$tag" "$asset" "$tmp"

  # The .deb (system libs) is the supported Linux build; an AppImage installed
  # alongside it lands in ~/.local/bin and usually shadows /usr/bin/$BIN_NAME on
  # PATH, so the user ends up running the older-glibc bundle. Warn, don't block.
  if have dpkg && [[ -n "$(deb_installed_version)" ]]; then
    warn "the .deb is already installed; this AppImage in $INSTALL_DIR will shadow it on PATH."
    warn "prefer the .deb (re-run without --appimage), or remove it: sudo apt remove $BIN_NAME"
  fi

  mkdir -p "$INSTALL_DIR" "$DATA_DIR"
  chmod +x "$DL"
  mv -f "$DL" "$INSTALL_DIR/$BIN_NAME.new"
  mv -f "$INSTALL_DIR/$BIN_NAME.new" "$INSTALL_DIR/$BIN_NAME"
  ln -sf "$BIN_NAME" "$INSTALL_DIR/$SHORTCUT"
  printf '%s\n' "$tag" > "$DATA_DIR/version"
  write_desktop_entry
  ensure_path

  ok "${cur:+upgraded to }Red Request $tag → $INSTALL_DIR/$BIN_NAME"
  verify_install "$INSTALL_DIR/$BIN_NAME"
  say "run it:  $BIN_NAME        (or  $SHORTCUT .  to open the current folder as a project)"
}

# ── macOS / Windows: download + verify, then hand off the GUI installer ─────
# GUI installers (.dmg / .exe) need a human to click through, so we fetch + verify
# the right asset for this os/arch and drop it where the user can find it, instead of
# installing headless. Degrades gracefully when that platform isn't published yet.
install_gui() {
  local tag asset tmp ck_text dest
  tag="$(resolve_tag)" || err "could not resolve the latest release tag"
  asset="$(asset_name)"
  say "Red Request $tag · $OS/$ARCH"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/red-request.XXXXXX")"
  trap '[ -n "${tmp:-}" ] && rm -rf "$tmp"' RETURN

  if ! download "$(asset_url "$tag" "$asset")" "$tmp/$asset" 2>/dev/null; then
    warn "no $OS/$ARCH build published in $tag yet."
    say  "browse all assets: https://github.com/$REPO/releases/tag/$tag"
    return 0
  fi
  ck_text="$(download "$(checksum_url "$tag")" /dev/stdout 2>/dev/null || true)"
  [[ -n "$ck_text" ]] && verify_sha256 "$tmp/$asset" "$ck_text" "$asset"

  dest="$HOME/Downloads"; [[ -d "$dest" ]] || dest="$PWD"
  mv -f "$tmp/$asset" "$dest/$asset"
  ok "downloaded + verified → $dest/$asset"
  case "$OS" in
    darwin)  say "open it, drag Red Request to Applications. First launch: right-click → Open (unsigned build)." ;;
    windows) say "run $asset to install." ;;
  esac
}

# Post-install sanity check: print the binary versions so a broken sidecar (e.g. a glibc-
# incompatible `red`) surfaces here, at install time, instead of as a blank window on first
# launch. $1 is the red-request binary path (it may not be on PATH in this shell yet).
verify_install() { # red_request_path
  local rr="$1" red v
  say "verifying…"
  if [[ -x "$rr" ]]; then
    # --version is headless on current builds; `timeout` guards older builds that ignore the
    # flag (it would otherwise launch the GUI and hang the installer).
    v="$(timeout 10 "$rr" --version 2>/dev/null | head -n1 || true)"
    [[ -n "$v" ]] && ok "$v" || warn "$BIN_NAME --version produced no output (build older than this installer expects)"
  else
    warn "$BIN_NAME not found at $rr"
  fi
  # The .deb installs a standalone /usr/bin/red; the AppImage bundles it (nothing on disk).
  red="$(command -v red 2>/dev/null || true)"
  if [[ -n "$red" ]]; then
    if v="$("$red" --version 2>&1)"; then
      ok "$v"
    else
      warn "the embedded reddb sidecar (red) failed to run: $v"
      warn "the app would open to a blank screen — re-run with --force, or report: $red --version"
    fi
  fi
}

main() {
  detect_platform
  case "$OS" in
    linux)          [[ "$LINUX_FORMAT" == "appimage" ]] && install_appimage || install_deb ;;
    darwin|windows) install_gui ;;
  esac
}

main
