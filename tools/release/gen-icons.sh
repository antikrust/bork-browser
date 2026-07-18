#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Build derp's icon set from browser-features/branding/logo.png.
#
# The logo is a wordmark, and "derp" is an illegible smudge below about 64px —
# which is exactly where taskbar, alt-tab and tab favicons live. So the small
# sizes use the face from the 'p' instead, which stays readable at 16px, and
# the wordmark takes over once there is room for it. A .icns is a container of
# per-size images, so one file carries both.
#
# Artwork choice follows the *logical* size, not the pixel count: icon_32x32@2x
# is 64 physical pixels shown at 32 points, so it gets the same artwork as
# icon_32x32.
#
# macOS only (sips and iconutil). Run from the repo root:
#   bash tools/release/gen-icons.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

SRC="browser-features/branding/logo.png"
OUT="browser-features/branding"
[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }

# Face crop, measured against the 1024x1024 source: the disc on the 'p' bowl.
FACE_SIZE=160
FACE_Y=425
FACE_X=712
FACE="$(mktemp -t derp-face).png"
trap 'rm -f "$FACE"' EXIT
sips -c "$FACE_SIZE" "$FACE_SIZE" --cropOffset "$FACE_Y" "$FACE_X" \
  "$SRC" --out "$FACE" >/dev/null

# Below this logical size the wordmark stops being readable.
SMALL_MAX=48
pick() { [ "$1" -le "$SMALL_MAX" ] && echo "$FACE" || echo "$SRC"; }

echo "building icns"
ISET="$(mktemp -d -t derp-iconset)/derp.iconset"
mkdir -p "$ISET"
# name:logical:pixels
for spec in \
  icon_16x16:16:16 icon_16x16@2x:16:32 \
  icon_32x32:32:32 icon_32x32@2x:32:64 \
  icon_128x128:128:128 icon_128x128@2x:128:256 \
  icon_256x256:256:256 icon_256x256@2x:256:512 \
  icon_512x512:512:512 icon_512x512@2x:512:1024
do
  name="${spec%%:*}"; rest="${spec#*:}"
  logical="${rest%%:*}"; pixels="${rest##*:}"
  sips -s format png -z "$pixels" "$pixels" "$(pick "$logical")" \
    --out "$ISET/$name.png" >/dev/null
done
iconutil -c icns "$ISET" -o "$OUT/firefox.icns"
rm -rf "$(dirname "$ISET")"

echo "building in-app png set"
for size in 16 32 48 64 128; do
  sips -s format png -z "$size" "$size" "$(pick "$size")" \
    --out "$OUT/icon${size}.png" >/dev/null
done

# A tightly-cropped wordmark. The source centres the mark in a square with a
# lot of transparent padding — measured, it fills only 37% of the canvas
# vertically — so anywhere the logo is placed by width (page headers, the help
# topbar) the square version renders it small inside a mostly empty box.
# Margin is generous enough to keep the soft shadow.
echo "building cropped wordmark"
sips -c 429 795 --cropOffset 295 119 "$SRC" --out "$OUT/wordmark.png" >/dev/null

# The About dialog has room for the wordmark whatever the size.
sips -s format png -z 192 192 "$SRC" --out "$OUT/about-logo.png" >/dev/null
sips -s format png -z 384 384 "$SRC" --out "$OUT/about-logo@2x.png" >/dev/null

echo "done:"
ls -1 "$OUT" | sed 's/^/  /'
