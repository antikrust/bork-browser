#!/usr/bin/env bash
# Get SHUT UP signed by Mozilla and stage the signed xpi for the download page.
#
# Release Firefox refuses any extension Mozilla has not signed, so the file the
# site offers has to be a signed one. AMO is the only signer there is.
#
# The add-on is LISTED: it has a public page in the AMO catalogue and Mozilla
# serves its updates, which is why the manifest carries no update_url — AMO
# rejects that field on listed add-ons, and Firefox falls back to Mozilla's own
# update service without it.
#
# Listed means a human reviews every version, which takes days rather than
# minutes, so this runs in two steps:
#
#   bash tools/release/sign-extension.sh            # submit a new version
#   bash tools/release/sign-extension.sh --fetch    # collect it once approved
#
# Submitting is expected to end with "awaiting review" — web-ext waits about
# fifteen minutes for a reviewer and then gives up, which is not a failure and
# is not treated as one here. Run --fetch when the approval mail arrives.
#
# Credentials come from https://addons.mozilla.org/developers/addon/api/key/
# and are read from the environment, never stored here:
#
#   export AMO_JWT_ISSUER='user:...'
#   export AMO_JWT_SECRET='...'
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/browser-features/extensions/shutup"
OUT="$ROOT/tools/release/site"
ADDON_ID="shutup@bork"
PUBLISHED="$OUT/shut-up.xpi"

: "${AMO_JWT_ISSUER:?set AMO_JWT_ISSUER (JWT issuer from the AMO API key page)}"
: "${AMO_JWT_SECRET:?set AMO_JWT_SECRET (JWT secret from the AMO API key page)}"

xpi_version() {
  unzip -p "$1" manifest.json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])'
}

# Publish a candidate only if Mozilla really signed it. An unsigned file under
# this name would be served to people whose Firefox then refuses to install it,
# and would quietly replace a good signature with a bad download.
publish() {
  local candidate="$1"
  if ! unzip -l "$candidate" | grep -q "META-INF/mozilla.rsa"; then
    echo "refusing to publish $candidate: no Mozilla signature inside" >&2
    exit 1
  fi
  mv "$candidate" "$PUBLISHED"
  echo "published: $PUBLISHED ($(xpi_version "$PUBLISHED"))"
}

# ------------------------------------------------------------------- fetch

if [ "${1:-}" = "--fetch" ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  AMO_ADDON_ID="$ADDON_ID" AMO_OUT="$tmp/signed.xpi" python3 "$ROOT/tools/release/amo-fetch.py"
  publish "$tmp/signed.xpi"

  # AMO hands back the newest APPROVED version, which is not necessarily the
  # version in this tree — a newer one may still be queued. Building on that
  # mismatch would ship bork an unsigned add-on without saying why.
  source_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$SRC/manifest.json")"
  published_version="$(xpi_version "$PUBLISHED")"
  if [ "$source_version" != "$published_version" ]; then
    echo
    echo "note: this tree is on $source_version but $published_version is the newest"
    echo "approved version. Do not release yet — $source_version is still in review."
    exit 0
  fi
  echo "now run: bash tools/release/production-build.sh --skip-runtime --install all"
  exit 0
fi

# ------------------------------------------------------------------ submit

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# Same exclusions the injector applies when it packs the add-on into bork, so
# the signed download carries the same files as the shipped one.
set +e
npx --yes web-ext sign \
  --source-dir "$SRC" \
  --artifacts-dir "$OUT" \
  --channel listed \
  --amo-metadata "$ROOT/tools/release/amo-metadata.json" \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET" \
  --ignore-files "test/**" "*.md" "build.sh" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
set -e

# web-ext names its output after the add-on and version; the page links one
# stable filename so the link never needs editing.
candidate="$(ls -t "$OUT"/*.xpi 2>/dev/null | grep -v "$(basename "$PUBLISHED")\$" | head -1 || true)"
if [ -n "$candidate" ]; then
  publish "$candidate"
  exit 0
fi

if grep -q "timeout exceeded" "$log"; then
  echo
  echo "submitted and queued for review — this is the normal outcome for a"
  echo "listed add-on, not a failure. Nothing on the site has changed; it keeps"
  echo "serving $(xpi_version "$PUBLISHED"). When the approval mail arrives:"
  echo "  bash tools/release/sign-extension.sh --fetch"
  exit 0
fi

echo "submission failed — see the output above" >&2
exit "${status:-1}"
