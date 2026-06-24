#!/usr/bin/env bash
#
# Red Request uninstaller.
#
#   curl -fsSL https://raw.githubusercontent.com/reddb-io/red-request/main/uninstall.sh | bash
#
# Removes BOTH Linux install forms in one pass: the .deb (via apt) and the AppImage
# single-file build at ~/.local/bin/red-request, plus the `rr` shortcut, the version
# stamp, the desktop entry, and the PATH line install.sh added.
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
SUDO=""; [[ $EUID -ne 0 ]] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
rm_path() { [[ -e "$1" || -L "$1" ]] && rm -rf "$1" && { echo "✓ removed $1"; removed=1; }; return 0; }

# The `rr` shortcut — only if it points at our binary (don't clobber an unrelated `rr`).
# install.sh creates it in ~/.local/bin (AppImage) or /usr/local/bin (.deb); the target is
# the AppImage's relative `red-request` or the absolute `/usr/bin/red-request` (.deb).
for sc in "$INSTALL_DIR/$SHORTCUT" "/usr/local/bin/$SHORTCUT"; do
  [[ -L "$sc" ]] || continue
  rr_tgt="$(readlink "$sc")"
  [[ "$rr_tgt" == "$BIN_NAME" || "${rr_tgt##*/}" == "$BIN_NAME" ]] || continue
  if [[ "$sc" == /usr/local/* ]]; then
    $SUDO rm -f "$sc" && { echo "✓ removed $sc"; removed=1; }
  else
    rm_path "$sc"
  fi
done
rm_path "$INSTALL_DIR/$BIN_NAME"
rm_path "$INSTALL_DIR/$BIN_NAME.new"     # stray temp from an interrupted upgrade
rm_path "$DATA_DIR"
rm_path "$DESKTOP_DIR/red-request.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true

# Strip the PATH block install.sh appended, from whichever rc has it (incl. fish).
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile" "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"; do
  [[ -f "$rc" ]] || continue
  if grep -q '# >>> red-request >>>' "$rc"; then
    tmp="$(mktemp)"
    sed '/# >>> red-request >>>/,/# <<< red-request <<</d' "$rc" > "$tmp" && mv "$tmp" "$rc"
    echo "✓ removed PATH block from $rc"; removed=1
  fi
done

# The .deb install (install.sh's default Linux path) — purge so config files go too.
# Deliberately NO `autoremove` / `--auto-remove`: that would drag out shared runtime
# deps (libwebkit2gtk-4.1-0, libgtk-3-0, …) other apps may rely on. We only remove
# the red-request package itself; its dependencies stay installed.
if command -v dpkg >/dev/null 2>&1 && dpkg -s "$BIN_NAME" >/dev/null 2>&1; then
  if $SUDO apt-get purge -y "$BIN_NAME"; then echo "✓ removed apt package $BIN_NAME"; removed=1; fi
fi

if [[ "$removed" == "1" ]]; then
  echo "✅ Red Request uninstalled. (App data in ~/.red/request was kept.)"
else
  echo "Red Request does not appear to be installed."
fi
