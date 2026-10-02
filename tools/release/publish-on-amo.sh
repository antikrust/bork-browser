#!/usr/bin/env bash
# Put an extension in Mozilla's public catalogue.
#
# This is the OTHER channel. sign-extension.sh submits unlisted versions: a
# robot signs them in minutes, nobody else can find them, and we host the file
# and serve its updates. That is what the bundled copies and the site download
# run on, and none of it changes.
#
# Listed is the public page on addons.mozilla.org, found by search, installed
# by strangers, updated by Mozilla. A person reviews every version, so this
# returns with the version in a queue rather than with a file.
#
#   bash tools/release/publish-on-amo.sh [youtube-control|media-control]
#
# The upload is the same tree as the signed one with ONE change: the
# update_url comes out. A listed add-on is updated by AMO, and AMO rejects a
# listed version that points its updates somewhere else. The repo keeps one
# manifest; the edit happens in a copy that lives as long as this script does.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

HOSTS_ENV="${BORK_HOSTS_ENV:-$ROOT/tools/release/hosts.env}"
if [ -f "$HOSTS_ENV" ]; then
  # shellcheck source=/dev/null
  source "$HOSTS_ENV"
fi
[ -n "${AMO_JWT_ISSUER:-}" ] || unset AMO_JWT_ISSUER
[ -n "${AMO_JWT_SECRET:-}" ] || unset AMO_JWT_SECRET
export AMO_JWT_ISSUER AMO_JWT_SECRET

# The catalogue page needs a one-line summary and a category. Both come from
# what the add-on already says about itself rather than being written for the
# listing: the summary is the manifest's own description.
case "${1:-youtube-control}" in
  youtube-control)
    SRC="$ROOT/browser-features/extensions/youtube-control"
    ADDON_ID="youtube-control@bork"
    CATEGORY="photos-music-videos"
    ;;
  media-control)
    SRC="$ROOT/browser-features/extensions/media-control"
    ADDON_ID="media-control@bork"
    CATEGORY="privacy-security"
    ;;
  *)
    echo "unknown add-on: ${1:-}. Known: youtube-control, media-control" >&2
    exit 1
    ;;
esac

: "${AMO_JWT_ISSUER:?set AMO_JWT_ISSUER (JWT issuer from the AMO API key page)}"
: "${AMO_JWT_SECRET:?set AMO_JWT_SECRET (JWT secret from the AMO API key page)}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The catalogue keeps its own version line, asked of AMO rather than tracked
# here: a number the self-hosted channel has already spent cannot be reused.
LISTED_VERSION="$(AMO_ADDON_ID="$ADDON_ID" AMO_MODE=next-listed-version \
  python3 "$ROOT/tools/release/amo-sign.py")"
echo "catalogue version: $LISTED_VERSION"

cp -R "$SRC" "$work/src"
FIELDS="$(python3 - "$work/src/manifest.json" "$LISTED_VERSION" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
manifest["version"] = sys.argv[2]
gecko = manifest.setdefault("browser_specific_settings", {}).setdefault("gecko", {})
gecko.pop("update_url", None)
json.dump(manifest, open(sys.argv[1], "w"), indent=2, ensure_ascii=False)
# AMO caps the summary at 250 characters.
print(manifest["name"])
print(manifest.get("description", "")[:250])
PY
)"
# Two lines out of one call, so the manifest is only parsed once.
NAME="$(printf '%s\n' "$FIELDS" | sed -n 1p)"
SUMMARY="$(printf '%s\n' "$FIELDS" | sed -n 2p)"

( cd "$work/src" && zip -qr -X "$work/upload.zip" . -x 'test/*' '*.md' 'build.sh' '.gitignore' )

AMO_ADDON_ID="$ADDON_ID" \
AMO_ZIP="$work/upload.zip" \
AMO_CHANNEL="listed" \
AMO_NAME="$NAME" \
AMO_SUMMARY="$SUMMARY" \
AMO_CATEGORY="$CATEGORY" \
python3 "$ROOT/tools/release/amo-sign.py"
