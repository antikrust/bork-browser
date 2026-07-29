#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Install bork's icons into a runtime tree.
#
# Icons are binary, so tools/patches cannot carry them the way it carries the
# brand strings — they have to be copied in after the runtime is unpacked.
#
# Takes the app root: the directory holding browser/ and chrome.manifest, which
# is Contents/Resources on macOS and the app directory elsewhere.
# Idempotent, and quiet about targets a given platform does not have.
#
#   bash tools/release/brand-icons.sh _dist/bin/floorp/Floorp.app/Contents/Resources

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

approot="${1:?usage: brand-icons.sh /path/to/app-root}"
src="browser-features/branding"
[ -d "$approot" ] || { echo "no such app root: $approot" >&2; exit 1; }
[ -f "$src/firefox.icns" ] || {
  echo "icons not built — run tools/release/gen-icons.sh first" >&2; exit 1; }

installed=0

# macOS Dock/Finder icon. Absent on Linux and Windows, which is fine.
if [ -f "$approot/firefox.icns" ]; then
  cp "$src/firefox.icns" "$approot/firefox.icns"
  installed=$((installed + 1))
fi

# In-app branding: the About dialog, the welcome page, window icons.
branding="$approot/browser/chrome/browser/content/branding"
if [ -d "$branding" ]; then
  for f in icon16.png icon32.png icon48.png icon64.png icon128.png \
           about-logo.png "about-logo@2x.png"; do
    if [ -f "$src/$f" ]; then
      cp "$src/$f" "$branding/$f"
      installed=$((installed + 1))
    fi
  done
fi

# Linux window/taskbar icon: GTK reads browser/chrome/icons/default/
# defaultNN.png — without these the dock still shows the runtime's own
# (Firefox) art. Same masters as everything above, so changing the icon
# stays a one-place edit: swap browser-features/branding/logo.png, run
# gen-icons.sh, rebuild.
icondir="$approot/browser/chrome/icons/default"
if [ -d "$icondir" ]; then
  for n in 16 32 48 64 128 256; do
    if [ -f "$src/icon$n.png" ] && [ -f "$icondir/default$n.png" ]; then
      cp "$src/icon$n.png" "$icondir/default$n.png"
      installed=$((installed + 1))
    fi
  done
fi

echo "branded $installed icon file(s) under $approot"
