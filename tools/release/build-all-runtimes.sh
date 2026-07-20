#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# build-all-runtimes.sh — build the derp/Gecko runtime for every platform and
# publish the artifacts to the private derp-runtime release, so the derp release
# pipeline (build-derp-packages.sh) ships on runtimes WE built.
#
# This encodes the proven per-platform recipes (see the project-runtime-build-recipe
# memory for the full story and every gotcha). The three build environments differ:
#
#   mac     — native on this Apple-Silicon Mac (Xcode SDK >= 26.4 required)
#   linux   — on the `sentience` box over SSH
#   windows — natively inside the `derp-winbuild` KVM VM on `sentience`, over WinRM
#
# Because the environments span machines, this driver is meant to be run FROM the
# Mac. It builds mac locally and drives sentience/VM over SSH for the others.
#
# Usage:
#   build-all-runtimes.sh <release-tag> [all|mac|linux|windows]
#
# Example:
#   build-all-runtimes.sh derp-runtime-152.0.7-2 all
#
# Prereqs: gh authed for RUNTIME_REPO on whichever host publishes; ssh access to
# `sentience`; the VM present and reachable. Each lane checks its own tools.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TAG="${1:?release tag required, e.g. derp-runtime-152.0.7-2}"
WHICH="${2:-all}"

RUNTIME_REPO="${DERP_RUNTIME_REPO:-100mountains/derp-runtime}"
SENTIENCE="${DERP_BUILD_HOST:-sentience}"
PUBLISH="$ROOT/tools/release/publish-runtime-artifact.sh"

# --- shared build knobs (proven) --------------------------------------------
# --enable-chrome-format=flat : derp's patcher edits loose chrome; without this
#                               the package ships omni.ja and patching fails.
# --disable-debug-symbols     : halves the gkrust LLVM codegen peak; without it
#                               gkrust OOMs on 22-32 GB boxes (hit on linux+win).
# Both are baked into each lane's mozconfig below.

log()  { printf '\033[34m[build-all]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[build-all] %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
build_mac() {
  log "mac: native build on this machine"
  local base=/Volumes/Instruments/derp-build
  local src=$base/derp-runtime-mac
  [ -f "$src/mach" ] || fail "mac source missing at $src (clone derp-runtime there first)"
  local sdk; sdk="$(xcrun --sdk macosx --show-sdk-path)"
  [ -d "$sdk" ] || fail "no macOS SDK (need Xcode >= 26.4)"

  # explicit rust paths so mach never calls the (unconfigured) `rustup which`
  local tc; tc="$(rustup show home)/toolchains/$(rustup show active-toolchain | awk '{print $1}')/bin"
  ( cd "$src"
    source "$base/macbuildenv.sh"
    export RUSTC="$tc/rustc" CARGO="$tc/cargo"
    ./mach build
    ./mach package )
  local dmg; dmg="$(find "$base/obj-mac-aarch64/dist" -maxdepth 1 -name 'floorp-*.mac.dmg' | head -1)"
  [ -f "$dmg" ] || fail "mac: no dmg produced"
  "$PUBLISH" mac aarch64 "$dmg" "$TAG"
}

# ---------------------------------------------------------------------------
build_linux() {
  log "linux: build on $SENTIENCE"
  ssh "$SENTIENCE" 'bash -s' <<'REMOTE'
set -euo pipefail
cd /mnt/terra/derp-runtime-build/derp-runtime
source /mnt/terra/derp-runtime-build/buildenv.sh
export MOZCONFIG=/mnt/terra/derp-runtime-build/mozconfig-linux-x86_64
./mach build
./mach package
REMOTE
  # pull the flat tarball off sentience and publish from here
  local out="/tmp/floorp-linux-x86_64-moz-artifact.tar.xz"
  scp -q "$SENTIENCE:/mnt/terra/derp-runtime-build/obj-linux-x86_64/dist/floorp-*.linux-x86_64.tar.xz" "$out"
  "$PUBLISH" linux x86_64 "$out" "$TAG"
}

# ---------------------------------------------------------------------------
build_windows() {
  log "windows: native build in derp-winbuild VM (driven from $SENTIENCE)"
  # The VM build + pull is scripted on sentience (winps95.py runner, scheduled
  # task with RunLevel Highest for msiexec, base64-over-WinRM pull). Trigger it:
  ssh "$SENTIENCE" 'bash /mnt/terra/derp-winbuild/run-win-build.sh' \
    || fail "windows VM build failed (see /mnt/terra/derp-winbuild/*.log on $SENTIENCE)"
  local out="/tmp/floorp-windows-x86_64-moz-artifact.zip"
  scp -q "$SENTIENCE:/mnt/terra/derp-runtime-build/artifacts/floorp-windows-x86_64-moz-artifact.zip" "$out"
  "$PUBLISH" windows x86_64 "$out" "$TAG"
}

# ---------------------------------------------------------------------------
case "$WHICH" in
  mac)     build_mac ;;
  linux)   build_linux ;;
  windows) build_windows ;;
  all)     build_linux; build_windows; build_mac ;;
  *) fail "unknown target: $WHICH (all|mac|linux|windows)" ;;
esac

log "done. Artifacts published to $RUNTIME_REPO@$TAG."
log "The derp release pipeline (build-derp-packages.sh) fetches them via OWN_RUNTIME_FILES."
