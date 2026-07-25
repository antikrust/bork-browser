#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Build bork's icon set from browser-features/branding/logo.png.
#
# The app icon is the face from the 'p' at every size, and only the face. The
# eyes are the part that reads at a glance; "bork" set across 64px of Dock is
# a smudge. The wordmark still gets used where there is room for it — the
# welcome page, the help topbar and the About dialog — just not here.
#
# Caveat worth knowing before someone "fixes" the blur: the face is a small
# region of a raster source (about 128px inside 1024), so the 512 and 1024
# entries are upscaled and soft. Everything up to 256 is native or a
# downscale, which covers the Dock, alt-tab and Finder. Only Get Info and
# Quick Look show the soft ones. Vector art would fix it; there is none.
#
# macOS only (sips, iconutil and the Swift toolchain). Run from the repo root:
#   bash tools/release/gen-icons.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

SRC="browser-features/branding/logo.png"
OUT="browser-features/branding"
[ -f "$SRC" ] || { echo "missing $SRC" >&2; exit 1; }

# The PRODUCT wordmark is its own artwork: "bork" in white on transparent.
# logo.png is derp tech's mark (bork is by derp tech) and its wordmark reads
# "derp", so it cannot stand in for the product name — the icons below still
# come from it, because the face is the shared brand glyph.
WORDMARK_SRC="browser-features/branding/logo-wordmark.png"

# Face crop, measured against the 1024x1024 source: the disc on the 'p' bowl.
# Tight to the disc on purpose. A wider box reaches into the arc of the bowl's
# own outline, which nothing shows at 16px and everything shows once the same
# artwork is scaled up to fill a 512 slot.
FACE_SIZE=128
FACE_Y=442
FACE_X=731
FACE="$(mktemp -t bork-face).png"
trap 'rm -f "$FACE"' EXIT
sips -c "$FACE_SIZE" "$FACE_SIZE" --cropOffset "$FACE_Y" "$FACE_X" \
  "$SRC" --out "$FACE" >/dev/null

# The paper around the disc goes transparent (flood fill from the border —
# see face-alpha.swift for why a plain white->alpha key would blind him).
swift tools/release/face-alpha.swift "$FACE" >/dev/null

echo "building icns"
ISET="$(mktemp -d -t bork-iconset)/bork.iconset"
mkdir -p "$ISET"
for spec in \
  icon_16x16:16 icon_16x16@2x:32 \
  icon_32x32:32 icon_32x32@2x:64 \
  icon_128x128:128 icon_128x128@2x:256 \
  icon_256x256:256 icon_256x256@2x:512 \
  icon_512x512:512 icon_512x512@2x:1024
do
  name="${spec%%:*}"; pixels="${spec##*:}"
  sips -s format png -z "$pixels" "$pixels" "$FACE" \
    --out "$ISET/$name.png" >/dev/null
done
iconutil -c icns "$ISET" -o "$OUT/firefox.icns"
rm -rf "$(dirname "$ISET")"

# Window and taskbar icons — the app icon on Linux and Windows, so the face
# there too.
echo "building in-app png set"
for size in 16 32 48 64 128; do
  sips -s format png -z "$size" "$size" "$FACE" \
    --out "$OUT/icon${size}.png" >/dev/null
done

# A tightly-cropped wordmark, from the product artwork. The source centres the
# lettering in a 1024 square with a lot of transparent padding (measured: the
# glyphs occupy x187..868, y406..617), so anywhere the logo is placed by width
# with height:auto — the welcome page, the Hub header — the square version
# renders it small inside a mostly empty box. Crop to the measured bounding box
# plus a 12px margin.
#
# The art is WHITE on transparent, so every consumer must sit it on a dark
# surface or invert it: those pages support the light daisyUI theme too, where
# white-on-light would be invisible (see .bork-wordmark in pages-welcome).
echo "building cropped wordmark"
[ -f "$WORDMARK_SRC" ] || { echo "missing $WORDMARK_SRC" >&2; exit 1; }
sips -c 236 706 --cropOffset 394 175 "$WORDMARK_SRC" --out "$OUT/wordmark.png" >/dev/null

# Every consumer keeps its own copy of the wordmark, and they were all hand
# copies — which is how they silently kept the old artwork after the source
# changed. Push the freshly cropped one to each so they cannot drift again:
#   - the welcome/Hub pages import it as a bundled asset
#   - the help pages load it as .brand-mark in their topbar
WELCOME_ASSETS="browser-features/pages-welcome/src/assets"
[ -d "$WELCOME_ASSETS" ] && cp "$OUT/wordmark.png" "$WELCOME_ASSETS/wordmark.png"
[ -d "browser-features/help" ] && cp "$OUT/wordmark.png" "browser-features/help/logo.png"

# about-logo is a logo MARK, not a wordmark: Firefox uses it wherever a small
# brand glyph sits beside its own text — the Settings sidebar renders it at
# 24x24 next to the word "Settings", and the About dialog puts it above the
# name. Generated from the full source it carried the wordmark, so those places
# spelled out the old "derp" artwork next to correct "Bork" text. Use the face,
# like every other icon here does; it also survives 24px, which a wordmark
# cannot. (Upscaled from the 128px disc, the same compromise the icns 256+
# slots already make — a true fix needs higher-resolution bork artwork.)
sips -s format png -z 192 192 "$FACE" --out "$OUT/about-logo.png" >/dev/null
sips -s format png -z 384 384 "$FACE" --out "$OUT/about-logo@2x.png" >/dev/null

echo "done:"
ls -1 "$OUT" | sed 's/^/  /'
