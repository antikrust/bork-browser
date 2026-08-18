#!/usr/bin/env bash
# Get a bundled add-on signed by Mozilla and stage the signed xpi for the site.
#
# Release Firefox refuses any extension Mozilla has not signed, so the file the
# site offers has to be a signed one. AMO is the only signer there is.
#
# UNLISTED: signed on demand by AMO's robot in a couple of minutes, with no
# human review and no public catalogue page. We host the file and we serve its
# updates, which is why the manifest carries an update_url and why this
# rewrites the update manifest beside the xpi.
#
#   bash tools/release/sign-extension.sh [shutup|fuckoff]
#
# It returns with the signed xpi already in place; there is nothing to wait for
# and nothing to collect later.
#
# Credentials come from https://addons.mozilla.org/developers/addon/api/key/
# and are read from the environment, never stored here:
#
#   export AMO_JWT_ISSUER='user:...'
#   export AMO_JWT_SECRET='...'
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/tools/release/site"

# Which add-on to sign. Everything below is derived from this block, so a new
# bundled extension needs four lines here and nothing else.
case "${1:-shutup}" in
  shutup)
    SRC="$ROOT/browser-features/extensions/shutup"
    ADDON_ID="shuddup@bork"
    SLUG="shut-up"
    ;;
  fuckoff)
    SRC="$ROOT/browser-features/extensions/fuckoff"
    ADDON_ID="fuckoff@bork"
    SLUG="fuckoff"
    ;;
  *)
    echo "unknown add-on: ${1:-}. Known: shutup, fuckoff" >&2
    exit 1
    ;;
esac

PUBLISHED="$OUT/$SLUG.xpi"
UPDATES="$OUT/$SLUG-updates.json"
UPDATE_LINK="https://borkbrowser.online/$SLUG.xpi"

: "${AMO_JWT_ISSUER:?set AMO_JWT_ISSUER (JWT issuer from the AMO API key page)}"
: "${AMO_JWT_SECRET:?set AMO_JWT_SECRET (JWT secret from the AMO API key page)}"

xpi_version() {
  unzip -p "$1" manifest.json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])'
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Same exclusions the injector applies when it packs the add-on into bork, so
# the signed download carries the same files as the shipped one.
( cd "$SRC" && zip -qr -X "$work/upload.zip" . -x 'test/*' '*.md' 'build.sh' '.gitignore' )

AMO_ADDON_ID="$ADDON_ID" \
AMO_ZIP="$work/upload.zip" \
AMO_OUT="$work/signed.xpi" \
python3 "$ROOT/tools/release/amo-sign.py"

# Publish only if Mozilla really signed it. An unsigned file under this name
# would be served to people whose Firefox then refuses to install it, and would
# quietly replace a good signature with a bad download.
if ! unzip -l "$work/signed.xpi" | grep -q "META-INF/mozilla.rsa"; then
  echo "refusing to publish: no Mozilla signature inside the returned file" >&2
  exit 1
fi

mv "$work/signed.xpi" "$PUBLISHED"
version="$(xpi_version "$PUBLISHED")"

# Nobody updates an unlisted add-on but us. Firefox reads this file at the
# manifest's update_url, compares versions, and installs the linked xpi only if
# the hash matches — so it is written from the file just published rather than
# typed, because a stale hash here is a silently broken update.
hash="sha256:$(shasum -a 256 "$PUBLISHED" | cut -d' ' -f1)"
cat > "$UPDATES" <<EOF
{
  "addons": {
    "$ADDON_ID": {
      "updates": [
        {
          "version": "$version",
          "update_link": "$UPDATE_LINK",
          "update_hash": "$hash"
        }
      ]
    }
  }
}
EOF

echo "published: $PUBLISHED ($version)"
echo "updates:   $UPDATES"
echo "now run: bash tools/release/production-build.sh --skip-runtime all"
