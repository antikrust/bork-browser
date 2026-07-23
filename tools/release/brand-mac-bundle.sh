#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Brand a Floorp.app bundle as Bork.
#
# The macOS application menu title and the Dock/Finder name come from the
# bundle plists, not from the runtime's brand strings (tools/patches/
# bork-branding.patch covers those), so they need their own pass. Run against
# the dev tree as well as the packaged copy, otherwise the development browser
# keeps announcing itself as Floorp.
#
# Safe to run in place: the runtime ships an adhoc/linker-signed executable
# with Info.plist unbound and no sealed resources, so plist edits do not
# invalidate the signature. Callers that repack for distribution should still
# re-sign afterwards (build-bork-packages.sh does).
#
# Idempotent — a second run finds nothing left to rename.

set -euo pipefail
app="${1:?usage: brand-mac-bundle.sh /path/to/Something.app}"
[ -d "$app/Contents" ] || { echo "not an app bundle: $app" >&2; exit 1; }

/usr/libexec/PlistBuddy -c "Set :CFBundleName Bork" "$app/Contents/Info.plist"

# macOS resolves the app icon from CFBundleIconName — an entry in the bundle's
# asset catalog — in preference to CFBundleIconFile, and the runtime ships an
# Assets.car whose AppIcon is still Floorp's purple F. So replacing
# firefox.icns changed nothing anyone could see: Finder and the Dock never
# read it. Dropping the key falls resolution back to CFBundleIconFile, which
# brand-icons.sh has already replaced. Leaves Assets.car alone, since the rest
# of it is still the runtime's own artwork.
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" \
  "$app/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Bork" \
  "$app/Contents/Info.plist" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Bork" \
    "$app/Contents/Info.plist"

# InfoPlist.strings is UTF-16LE and plutil refuses to rewrite it, so the
# rename round-trips through iconv.
for f in "$app/Contents/Resources"/*.lproj/InfoPlist.strings; do
  [ -f "$f" ] || continue
  iconv -f UTF-16LE -t UTF-8 "$f" | sed 's/"Floorp"/"Bork"/g' \
    | iconv -f UTF-8 -t UTF-16LE > "$f.new" && mv "$f.new" "$f"
done

echo "branded: $app"
