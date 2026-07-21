#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# production-build.sh — the PRODUCTION build mode, as opposed to the normal dev
# build (feles-build stage/dev, which just runs derp locally against a runtime).
#
# Production mode does the full chain end to end:
#   1. build the Gecko runtime for each platform we ship          (build-all-runtimes.sh)
#   2. build the production feature layer                         (feles-build build --phase before-mach)
#   3. overlay the feature layer onto each runtime and package    (build-derp-packages.sh)
#   4. upload the packages to your download site ($DERP_WEB_REMOTE)  (rsync)
#
# This is deliberately a thin orchestrator over the pieces that already exist and
# are individually proven — it wires them into one "ship it" command.
#
# Usage:
#   production-build.sh <runtime-tag> [--skip-runtime] [--no-upload] [mac linux windows | all]
#
#   --skip-runtime : reuse the already-published runtime tag instead of rebuilding
#                    the Gecko runtimes (rebuild is the long part; skip when only
#                    the feature layer changed).
#   --no-upload    : build packages but do not rsync to the download site.
#
# Example (feature-layer-only ship, reusing the current runtime):
#   production-build.sh derp-runtime-152.0.7-1 --skip-runtime all
#
# NOTE on branding: until M2 (runtimes built WITH a derp branding dir), the
# runtimes are nightly-branded and derp-branding.patch cannot apply. Visible
# branding (app name, Dock, icon) still comes from brand-mac-bundle.sh +
# derp-defaults; some internal strings read "Nightly/Floorp". Building the
# runtimes with --with-branding=browser/branding/derp closes that gap.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TAG="${1:?runtime tag required (e.g. derp-runtime-152.0.7-1)}"; shift || true
SKIP_RUNTIME=0
UPLOAD=1
LANES=()
for a in "$@"; do
  case "$a" in
    --skip-runtime) SKIP_RUNTIME=1 ;;
    --no-upload)    UPLOAD=0 ;;
    mac|linux|windows) LANES+=("$a") ;;
    all) LANES=(mac linux windows) ;;
    *) echo "unknown arg: $a" >&2; exit 1 ;;
  esac
done
[ ${#LANES[@]} -gt 0 ] || LANES=(mac linux windows)

# Local infra config (web target, hosts). Copy tools/release/hosts.env.example to
# tools/release/hosts.env and fill in your own; hosts.env is gitignored. Values
# are also overridable via the environment.
HOSTS_ENV="${DERP_HOSTS_ENV:-$ROOT/tools/release/hosts.env}"
# shellcheck source=/dev/null
[ -f "$HOSTS_ENV" ] && source "$HOSTS_ENV"

WEB_REMOTE="${DERP_WEB_REMOTE:-your-web-host:/var/www/example.com/derp/downloads}"
SITE_URL="${DERP_SITE_URL:-https://example.com/derp/}"

log() { printf '\033[35m[production]\033[0m %s\n' "$*"; }

# 1. runtimes (the long part) — skip to reuse an already-published tag
if [ "$SKIP_RUNTIME" = 0 ]; then
  log "building Gecko runtimes for: ${LANES[*]} (tag $TAG)"
  "$ROOT/tools/release/build-all-runtimes.sh" "$TAG" all
else
  log "reusing published runtime tag $TAG (--skip-runtime)"
fi

# Point the release packager at our runtime tag.
export DERP_OWN_RUNTIME_TAG="$TAG"

# 2 + 3. feature layer + overlay + package, per lane.
log "building feature layer and packaging: ${LANES[*]}"
"$ROOT/tools/release/build-derp-packages.sh" --build "${LANES[@]}"

# 4. upload
if [ "$UPLOAD" = 1 ]; then
  log "uploading packages to $WEB_REMOTE"
  # upload artifacts before any index so the page never lists absent files
  for d in dist/macos dist/linux dist/windows; do
    [ -d "$d" ] || continue
    rsync -av "$d/" "$WEB_REMOTE/"
  done
  # flat basenames — the packages are served flat (rsync above uses "$d/"), so a
  # subdir-prefixed sums file fails `sha256sum -c` on the server.
  ( cd dist && find macos linux windows -type f 2>/dev/null -exec shasum -a 256 {} \; \
      | sed -E 's#  .*/#  #' > SHA256SUMS.txt ) || true
  [ -f dist/SHA256SUMS.txt ] && rsync -av dist/SHA256SUMS.txt "$WEB_REMOTE/"
  log "uploaded. live at $SITE_URL"
else
  log "skipped upload (--no-upload); packages in dist/"
fi

log "production build done."
