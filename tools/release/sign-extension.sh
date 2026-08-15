#!/usr/bin/env bash
# Sign SHUT UP with Mozilla and stage the signed xpi for the download page.
#
# Release Firefox refuses any extension Mozilla has not signed, so the file the
# site offers has to be a signed one. AMO is the only signer there is.
#
# The add-on is LISTED: it has a public page in the AMO catalogue and Mozilla
# serves its updates, which is why the manifest carries no update_url — AMO
# rejects that field on listed add-ons, and Firefox falls back to Mozilla's own
# update service without it.
#
# Every new version needs this run again — production-build.sh will not
# overwrite a signed xpi with unsigned build output, so a forgotten run leaves
# the download on the old version and says so loudly rather than shipping
# something release Firefox rejects.
#
# Credentials come from https://addons.mozilla.org/developers/addon/api/key/
# and are read from the environment, never stored here:
#
#   export AMO_JWT_ISSUER='user:...'
#   export AMO_JWT_SECRET='...'
#   bash tools/release/sign-extension.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/browser-features/extensions/shutup"
OUT="$ROOT/tools/release/site"

: "${AMO_JWT_ISSUER:?set AMO_JWT_ISSUER (JWT issuer from the AMO API key page)}"
: "${AMO_JWT_SECRET:?set AMO_JWT_SECRET (JWT secret from the AMO API key page)}"

# Same exclusions the injector applies when it packs the add-on into bork, so
# the signed download carries the same files as the shipped one.
npx --yes web-ext sign \
  --source-dir "$SRC" \
  --artifacts-dir "$OUT" \
  --channel listed \
  --amo-metadata "$ROOT/tools/release/amo-metadata.json" \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET" \
  --ignore-files "test/**" "*.md" "build.sh"

# web-ext names its output after the add-on and version; the page links one
# stable filename so the link never needs editing.
newest="$(ls -t "$OUT"/*.xpi | grep -v '/shut-up\.xpi$' | head -1)"
mv "$newest" "$OUT/shut-up.xpi"
echo "signed: $OUT/shut-up.xpi"

# No update manifest to write: Mozilla serves updates for listed add-ons.
