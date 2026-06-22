#!/usr/bin/env bash
#
# Red Request uninstaller.
#
#   curl -fsSL https://raw.githubusercontent.com/reddb-io/red-request/main/uninstall.sh | bash
#
# Removes the single-file binary installed by install.sh (the AppImage at
# ~/.local/bin/red-request, the `rr` shortcut, the version stamp, the desktop entry,
# and the PATH line install.sh added). Also clears a legacy .deb install if present.
#
# App data under <project>/.red/request and ~/.red/request is left untouched — delete
# those by hand if you also want to wipe your requests/collections.
set -euo pipefail

BIN_NAME="red-request"
SHORTCUT="rr"
INSTALL_DIR="${RED_REQUEST_INSTALL_DIR:-${INSTALL_DIR:-$HOME/.local/bin}}"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/red-request"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"

removed=0
rm_path() { [[ -e "$1" || -L "$1" ]] && rm -rf "$1" && { echo "✓ removed $1"; removed=1; }; return 0; }

# The `rr` shortcut — only if it points at our binary (don't clobber an unrelated `rr`).
if [[ -L "$INSTALL_DIR/$SHORTCUT" && "$(readlink "$INSTALL_DIR/$SHORTCUT")" == "$BIN_NAME" ]]; then
  rm_path "$INSTALL_DIR/$SHORTCUT"
fi
rm_path "$INSTALL_DIR/$BIN_NAME"
rm_path "$INSTALL_DIR/$BIN_NAME.new"     # stray temp from an interrupted upgrade
rm_path "$DATA_DIR"
rm_path "$DESKTOP_DIR/red-request.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true

# Strip the PATH block install.sh appended, from whichever rc has it.
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
  [[ -f "$rc" ]] || continue
  if grep -q '# >>> red-request >>>' "$rc"; then
    tmp="$(mktemp)"
    sed '/# >>> red-request >>>/,/# <<< red-request <<</d' "$rc" > "$tmp" && mv "$tmp" "$rc"
    echo "✓ removed PATH block from $rc"; removed=1
  fi
done

# Legacy .deb install (older installer / the apt path).
if command -v dpkg >/dev/null 2>&1 && dpkg -s "$BIN_NAME" >/dev/null 2>&1; then
  sudo=""; [[ $EUID -ne 0 ]] && command -v sudo >/dev/null 2>&1 && sudo="sudo"
  $sudo apt-get remove -y "$BIN_NAME" && echo "✓ removed apt package $BIN_NAME"; removed=1
fi

if [[ "$removed" == "1" ]]; then
  echo "✅ Red Request uninstalled. (App data in ~/.red/request was kept.)"
else
  echo "Red Request does not appear to be installed."
fi
