#!/usr/bin/env bash
#
# Red Request installer
#
#   curl -fsSL https://raw.githubusercontent.com/reddb-io/red-request/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --version v0.1.0
#
# Linux: downloads the .AppImage, installs it to ~/.local/bin/red-request and adds a desktop
# entry. macOS / Windows: prints the right .dmg / .msi download link (GUI installers).
set -euo pipefail

REPO="reddb-io/red-request"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="red-request"
VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    -h|--help)
      cat <<EOF
Red Request installer

Usage: install.sh [OPTIONS]
  --version <vX.Y.Z>     Install a specific release (default: latest)
  --install-dir <path>   Where to put the launcher (default: ~/.local/bin)
  -h, --help             This help
EOF
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

err() { echo "✗ $*" >&2; exit 1; }

detect_platform() {
  local os arch
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in
    Linux*) OS="linux" ;;
    Darwin*) OS="darwin" ;;
    MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
    *) err "Unsupported OS: $os" ;;
  esac
  case "$arch" in
    x86_64|amd64) ARCH="x86_64" ;;
    aarch64|arm64) ARCH="aarch64" ;;
    *) err "Unsupported architecture: $arch" ;;
  esac
}

fetch() { # url -> stdout
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  else err "need curl or wget"; fi
}
download() { # url dest
  if command -v curl >/dev/null 2>&1; then curl -fL -o "$2" "$1"
  else wget -O "$2" "$1"; fi
}

release_json() {
  local api
  if [[ -n "$VERSION" ]]; then
    api="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
  else
    api="https://api.github.com/repos/$REPO/releases/latest"
  fi
  fetch "$api"
}

# Pick the first asset download URL whose filename matches an extended-regex pattern.
asset_url() { # json pattern
  echo "$1" \
    | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]+"' \
    | sed -E 's/.*"(https[^"]+)".*/\1/' \
    | grep -iE "$2" \
    | head -1
}

main() {
  detect_platform
  local json tag
  json="$(release_json)" || err "could not reach the GitHub releases API"
  tag="$(echo "$json" | grep -oE '"tag_name"[^,]*' | sed -E 's/.*"([^"]+)"$/\1/' | head -1)"
  [[ -n "$tag" ]] || err "no release found${VERSION:+ for $VERSION}"
  echo "→ Red Request $tag ($OS/$ARCH)"

  if [[ "$OS" == "linux" ]]; then
    local archtok url tmp
    archtok=$([[ "$ARCH" == "x86_64" ]] && echo "amd64" || echo "aarch64")
    url="$(asset_url "$json" "${archtok}\\.AppImage$")"
    [[ -n "$url" ]] || url="$(asset_url "$json" "\\.AppImage$")"
    [[ -n "$url" ]] || err "no .AppImage asset in $tag"
    tmp="$(mktemp)"
    echo "→ Downloading $(basename "${url//%20/ }")"
    download "$url" "$tmp"
    mkdir -p "$INSTALL_DIR"
    install -m 0755 "$tmp" "$INSTALL_DIR/$BIN_NAME"
    rm -f "$tmp"

    # Desktop entry (best-effort; harmless if the dir doesn't exist).
    local apps="$HOME/.local/share/applications"
    mkdir -p "$apps"
    cat > "$apps/red-request.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Red Request
Comment=Open-source API client, powered by recker
Exec=$INSTALL_DIR/$BIN_NAME %U
Terminal=false
Categories=Development;Utility;
EOF

    echo "✅ Installed: $INSTALL_DIR/$BIN_NAME"
    case ":$PATH:" in
      *":$INSTALL_DIR:"*) echo "   Run: red-request" ;;
      *) echo "   Add to PATH:  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
    esac
    return
  fi

  # macOS / Windows: print the GUI installer link (can't curl|bash a .dmg/.msi cleanly).
  local pat
  if [[ "$OS" == "darwin" ]]; then
    pat=$([[ "$ARCH" == "x86_64" ]] && echo "x64.*\\.dmg$|x86_64.*\\.dmg$" || echo "aarch64.*\\.dmg$|arm64.*\\.dmg$")
  else
    pat="\\.msi$|setup\\.exe$"
  fi
  local url; url="$(asset_url "$json" "$pat")"
  [[ -n "$url" ]] || url="https://github.com/$REPO/releases/$([[ -n "$VERSION" ]] && echo "tag/$VERSION" || echo latest)"
  echo
  echo "Red Request ships a GUI installer for $OS. Download & open:"
  echo "   ${url//%20/ }"
}

main
