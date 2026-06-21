#!/usr/bin/env bash
#
# Red Request uninstaller (Linux). Removes the Debian package installed by install.sh. App
# data under <project>/.red/request and ~/.red/request is left untouched — delete those
# manually if you also want to wipe your requests/collections.
set -euo pipefail

sudo=""
[[ $EUID -ne 0 ]] && command -v sudo >/dev/null 2>&1 && sudo="sudo"

# Tauri's deb package name is the productName lowercased ("red-request").
if dpkg -s red-request >/dev/null 2>&1; then
  $sudo apt-get remove -y red-request
  echo "✅ Red Request uninstalled. (App data in ~/.red/request was kept.)"
else
  # Fall back to the old AppImage launcher layout if present.
  removed=0
  for f in "$HOME/.local/bin/red-request" "$HOME/.local/share/applications/red-request.desktop"; do
    [[ -e "$f" ]] && rm -f "$f" && echo "✓ removed $f" && removed=1
  done
  [[ "$removed" == "1" ]] || echo "Red Request does not appear to be installed."
fi
