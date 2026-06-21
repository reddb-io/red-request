#!/usr/bin/env bash
#
# Red Request uninstaller (Linux). Removes the launcher + desktop entry installed by
# install.sh. App data under <project>/.red/request and ~/.red/request is left untouched —
# delete those manually if you also want to wipe your requests/collections.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
BIN="$INSTALL_DIR/red-request"
DESKTOP="$HOME/.local/share/applications/red-request.desktop"

removed=0
if [[ -e "$BIN" ]]; then rm -f "$BIN" && echo "✓ removed $BIN" && removed=1; fi
if [[ -e "$DESKTOP" ]]; then rm -f "$DESKTOP" && echo "✓ removed $DESKTOP" && removed=1; fi

if [[ "$removed" == "1" ]]; then
  echo "✅ Red Request uninstalled. (App data in ~/.red/request and project .red/request was kept.)"
else
  echo "Nothing to remove at $BIN."
fi
