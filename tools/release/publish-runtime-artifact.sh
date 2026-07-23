#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Publish a self-built Gecko runtime artifact to the private bork-runtime repo,
# so the release pipeline (build-bork-packages.sh, OWN_RUNTIME_FILES) fetches
# OUR runtime instead of upstream's. Automates the "wire it up" step.
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
# Prereqs: gh authed for the runtime repo; the artifact already built + pulled
# out of the build host/VM (see BUILD.md for the per-platform build steps).

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Local infra config (runtime repo); hosts.env is gitignored — see hosts.env.example.
HOSTS_ENV="${BORK_HOSTS_ENV:-$ROOT/tools/release/hosts.env}"
# shellcheck source=/dev/null
[ -f "$HOSTS_ENV" ] && source "$HOSTS_ENV"

RUNTIME_REPO="${BORK_RUNTIME_REPO:-100mountains/bork-runtime}"

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
cp -f "$artifact" "$workdir/$canonical"
( cd "$workdir" && sha256sum "$canonical" > "$canonical.sha256" )
log "prepared $canonical + .sha256"

if [ -z "$tag" ]; then
  fail "no tag given; pass the bork-runtime release tag as arg 4"
fi

# Create the release if missing, then upload (clobber so re-publish is idempotent).
if ! gh release view "$tag" --repo "$RUNTIME_REPO" >/dev/null 2>&1; then
  log "creating release $tag on $RUNTIME_REPO"
  gh release create "$tag" --repo "$RUNTIME_REPO" --title "$tag" \
    --notes "Self-built bork/Gecko runtime artifacts." >/dev/null
fi

log "uploading $canonical to $RUNTIME_REPO@$tag"
gh release upload "$tag" --repo "$RUNTIME_REPO" --clobber \
  "$workdir/$canonical" "$workdir/$canonical.sha256"

log "published. build-bork-packages.sh will fetch it if '$canonical' is in OWN_RUNTIME_FILES."
