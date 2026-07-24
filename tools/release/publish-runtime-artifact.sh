#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Publish a self-built Gecko runtime artifact to the bork-runtime repo on shithub
# (self-hosted Forgejo), so the release pipeline (build-bork-packages.sh,
# OWN_RUNTIME_FILES) fetches OUR runtime instead of upstream's. Automates the
# "wire it up" step. The repo is public; publishing uses the Forgejo API.
#
# Usage:
#   publish-runtime-artifact.sh <platform> <arch> <local-artifact-path> [tag]
#
#   platform : linux | windows | mac
#   arch     : x86_64 | aarch64 | universal
#   tag      : bork-runtime release tag (default: bork-runtime-<VERSION>-<N>)
#
# Example:
#   publish-runtime-artifact.sh windows x86_64 \
#     /path/to/bork-runtime-build/artifacts/floorp-windows-x86_64-moz-artifact.zip \
#     bork-runtime-152.0.7-1
#
# Prereqs: BORK_FORGEJO_TOKEN set (a Forgejo token with write:repository scope
# for the runtime repo); the artifact already built + pulled out of the build
# host/VM (see BUILD.md for the per-platform build steps).

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Local infra config (runtime repo); hosts.env is gitignored — see hosts.env.example.
HOSTS_ENV="${BORK_HOSTS_ENV:-$ROOT/tools/release/hosts.env}"
# shellcheck source=/dev/null
[ -f "$HOSTS_ENV" ] && source "$HOSTS_ENV"

FORGEJO_HOST="${BORK_FORGEJO_HOST:-shithub.space}"
FORGEJO_TOKEN="${BORK_FORGEJO_TOKEN:-}"
RUNTIME_REPO="${BORK_RUNTIME_REPO:-n01/bork-runtime}"
API="https://${FORGEJO_HOST}/api/v1/repos/${RUNTIME_REPO}"

platform="${1:?platform required (linux|windows|mac)}"
arch="${2:?arch required (x86_64|aarch64|universal)}"
artifact="${3:?local artifact path required}"
tag="${4:-}"

log() { printf '\033[34m[publish-runtime]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[publish-runtime] %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$artifact" ] || fail "artifact not found: $artifact"

# Canonical artifact name the release pipeline + initializer.ts score by keyword.
case "$platform" in
  linux)   ext="tar.xz" ;;
  mac)     ext="dmg" ;;
  windows) ext="zip" ;;
  *) fail "unknown platform: $platform" ;;
esac
canonical="floorp-${platform}-${arch}-moz-artifact.${ext}"

# Integrity check before publishing (never ship a truncated transfer).
case "$ext" in
  zip)    unzip -t "$artifact" >/dev/null 2>&1 || fail "zip failed integrity check: $artifact" ;;
  tar.xz) tar tJf "$artifact" >/dev/null 2>&1 || fail "tar failed integrity check: $artifact" ;;
esac

workdir="$(dirname "$artifact")"
# The artifact may already carry the canonical name — the usage example above
# passes exactly that, and the build host stores the windows zip under it. `cp`
# a file onto itself exits 1, which would abort the whole publish under `set -e`.
if [ ! "$artifact" -ef "$workdir/$canonical" ]; then
  cp -f "$artifact" "$workdir/$canonical"
fi
( cd "$workdir" && sha256sum "$canonical" > "$canonical.sha256" )
log "prepared $canonical + .sha256"

if [ -z "$tag" ]; then
  fail "no tag given; pass the bork-runtime release tag as arg 4"
fi

# Create the release if missing, then upload (delete-then-add so re-publish is
# idempotent — Forgejo has no --clobber). All via the Forgejo API.
[ -n "$FORGEJO_TOKEN" ] || fail "BORK_FORGEJO_TOKEN not set (need a Forgejo token with write:repository for ${RUNTIME_REPO} on ${FORGEJO_HOST})"

# Release id for $tag, or empty if the release does not exist yet.
rid="$(curl -fsSL -H "Authorization: token $FORGEJO_TOKEN" "$API/releases/tags/$tag" 2>/dev/null \
  | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('id',''))
except Exception: print('')")"

if [ -z "$rid" ]; then
  log "creating release $tag on $RUNTIME_REPO@$FORGEJO_HOST"
  rid="$(curl -fsSL -H "Authorization: token $FORGEJO_TOKEN" -H 'Content-Type: application/json' \
    -X POST "$API/releases" \
    -d "{\"tag_name\":\"$tag\",\"name\":\"$tag\",\"body\":\"Self-built bork/Gecko runtime artifacts.\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")"
  [ -n "$rid" ] || fail "could not create release $tag on $RUNTIME_REPO"
fi

# Upload one asset, replacing any existing asset of the same name.
upload_asset() {
  local path="$1" name existing
  name="$(basename "$path")"
  existing="$(curl -fsSL -H "Authorization: token $FORGEJO_TOKEN" "$API/releases/$rid/assets" 2>/dev/null \
    | python3 -c "import sys,json
[print(a['id']) for a in json.load(sys.stdin) if a.get('name')=='$name']" 2>/dev/null)"
  if [ -n "$existing" ]; then
    log "replacing existing asset $name"
    curl -fsSL -H "Authorization: token $FORGEJO_TOKEN" -X DELETE \
      "$API/releases/$rid/assets/$existing" >/dev/null || true
  fi
  log "uploading $name to $RUNTIME_REPO@$tag"
  curl -fsSL -H "Authorization: token $FORGEJO_TOKEN" -F "attachment=@$path" \
    "$API/releases/$rid/assets?name=$name" >/dev/null \
    || fail "asset upload failed: $name"
}

upload_asset "$workdir/$canonical"
upload_asset "$workdir/$canonical.sha256"

log "published to https://${FORGEJO_HOST}/${RUNTIME_REPO}/releases/tag/$tag — build-bork-packages.sh will fetch it if '$canonical' is in OWN_RUNTIME_FILES."
