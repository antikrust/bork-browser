#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# build-all-runtimes.sh — build the derp/Gecko runtime for every platform and
# publish the artifacts to the derp-runtime release, so the derp release pipeline
# (build-derp-packages.sh) ships on runtimes WE built.
#
# This encodes the proven per-platform recipes (see BUILD.md for the full story
# and every gotcha). The three build environments differ:
#
#   mac     — native on this Apple-Silicon Mac (Xcode SDK >= 26.4 required)
#   linux   — on your Linux build host over SSH
#   windows — natively inside a KVM VM on the Linux host, driven over WinRM
#
# Because the environments span machines, this driver is meant to be run FROM the
# Mac. It builds mac locally and drives the Linux host / VM over SSH for the others.
#
# Hosts and paths are NOT hardcoded — copy tools/release/hosts.env.example to
# tools/release/hosts.env and fill in your own (that file is gitignored). Each
# value is also overridable via its DERP_* environment variable.
#
# Usage:
#   build-all-runtimes.sh <release-tag> [all|mac|linux|windows]
#
# Example:
#   build-all-runtimes.sh derp-runtime-152.0.7-2 all
#
# Prereqs: gh authed for the runtime repo; ssh access to your build host; the VM
# present and reachable. Each lane checks its own tools.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TAG="${1:?release tag required, e.g. derp-runtime-152.0.7-2}"
WHICH="${2:-all}"

# Local infra config (build hosts, paths). Copy tools/release/hosts.env.example
# to tools/release/hosts.env and fill in your own; every value is also overridable
# directly via the environment. hosts.env is gitignored.
HOSTS_ENV="${DERP_HOSTS_ENV:-$ROOT/tools/release/hosts.env}"
# shellcheck source=/dev/null
[ -f "$HOSTS_ENV" ] && source "$HOSTS_ENV"

RUNTIME_REPO="${DERP_RUNTIME_REPO:-100mountains/derp-runtime}"
BUILD_HOST="${DERP_BUILD_HOST:-your-linux-build-host}"        # SSH alias or user@host
MAC_BUILD_DIR="${DERP_MAC_BUILD_DIR:-$HOME/derp-build}"        # runtime tree on this Mac
LINUX_BUILD_DIR="${DERP_LINUX_BUILD_DIR:-/path/to/derp-runtime-build}"  # on the Linux host
WIN_BUILD_DIR="${DERP_WIN_BUILD_DIR:-/path/to/derp-winbuild}"  # VM helpers, on the Linux host
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
  local base="$MAC_BUILD_DIR"
  local src="$base/derp-runtime-mac"
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
  log "linux: build on $BUILD_HOST"
  # pass the remote build dir as $1 so this stays a quoted (non-interpolated) heredoc
  ssh "$BUILD_HOST" "bash -s '$LINUX_BUILD_DIR'" <<'REMOTE'
set -euo pipefail
BUILD_DIR="$1"
cd "$BUILD_DIR/derp-runtime"
source "$BUILD_DIR/buildenv.sh"
export MOZCONFIG="$BUILD_DIR/mozconfig-linux-x86_64"
./mach build
./mach package
REMOTE
  # pull the flat tarball off the build host and publish from here
  local out="/tmp/floorp-linux-x86_64-moz-artifact.tar.xz"
  scp -q "$BUILD_HOST:$LINUX_BUILD_DIR/obj-linux-x86_64/dist/floorp-*.linux-x86_64.tar.xz" "$out"
  "$PUBLISH" linux x86_64 "$out" "$TAG"
}

# ---------------------------------------------------------------------------
build_windows() {
  log "windows: native build in the KVM VM (driven from $BUILD_HOST)"
  # The VM build + pull is scripted on the build host (winps runner, scheduled
  # task with RunLevel Highest for msiexec, base64-over-WinRM pull). Trigger it:
  ssh "$BUILD_HOST" "bash '$WIN_BUILD_DIR/run-win-build.sh'" \
    || fail "windows VM build failed (see $WIN_BUILD_DIR/*.log on $BUILD_HOST)"
  local out="/tmp/floorp-windows-x86_64-moz-artifact.zip"
  scp -q "$BUILD_HOST:$LINUX_BUILD_DIR/artifacts/floorp-windows-x86_64-moz-artifact.zip" "$out"
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
