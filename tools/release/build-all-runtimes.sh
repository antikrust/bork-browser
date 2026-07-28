#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# build-all-runtimes.sh — build the bork/Gecko runtime for every platform and
# publish the artifacts to the bork-runtime release, so the bork release pipeline
# (build-bork-packages.sh) ships on runtimes WE built.
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
# value is also overridable via its BORK_* environment variable.
#
# Usage:
#   build-all-runtimes.sh <release-tag> [all|mac|linux|windows]
#
# Example:
#   build-all-runtimes.sh bork-runtime-152.0.7-2 all
#
# Prereqs: BORK_FORGEJO_TOKEN set (Forgejo write token for the runtime repo);
# ssh access to your build host; the VM present and reachable. Each lane checks
# its own tools.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

TAG="${1:?release tag required, e.g. bork-runtime-152.0.7-2}"
WHICH="${2:-all}"

# Local infra config (build hosts, paths). Copy tools/release/hosts.env.example
# to tools/release/hosts.env and fill in your own; every value is also overridable
# directly via the environment. hosts.env is gitignored.
HOSTS_ENV="${BORK_HOSTS_ENV:-$ROOT/tools/release/hosts.env}"
# shellcheck source=/dev/null
[ -f "$HOSTS_ENV" ] && source "$HOSTS_ENV"

RUNTIME_REPO="${BORK_RUNTIME_REPO:-n01/bork-runtime}"
BUILD_HOST="${BORK_BUILD_HOST:-your-linux-build-host}"        # SSH alias or user@host
MAC_BUILD_DIR="${BORK_MAC_BUILD_DIR:-$HOME/bork-build}"        # runtime tree on this Mac
LINUX_BUILD_DIR="${BORK_LINUX_BUILD_DIR:-/path/to/bork-runtime-build}"  # on the Linux host
WIN_BUILD_DIR="${BORK_WIN_BUILD_DIR:-/path/to/bork-winbuild}"  # VM helpers, on the Linux host
PUBLISH="$ROOT/tools/release/publish-runtime-artifact.sh"

# --- source sync -------------------------------------------------------------
# Every lane fetches the canonical runtime source before building. Without this
# the three build machines drift silently: on 2026-07-28 the mac tree carried an
# engine fix while the Linux host and the Windows VM were still pointed at the
# ABANDONED GitHub remote, so a "cross-platform" release shipped three different
# engines. A lane that cannot sync now FAILS instead of quietly building stale
# source.
#
# Windows builds from its own branch: the VM's checkout carries the build recipe
# (mozconfigs, upstream patches, branding) committed off the VM, so its branch is
# canonical + that recipe rather than canonical itself.
RUNTIME_GIT_URL="${BORK_RUNTIME_GIT_URL:-https://${BORK_FORGEJO_HOST:-shithub.space}/${RUNTIME_REPO}.git}"
RUNTIME_BRANCH="${BORK_RUNTIME_BRANCH:-nora-0.2.0}"
WIN_RUNTIME_BRANCH="${BORK_WIN_RUNTIME_BRANCH:-winbuild-canonical}"

# --- shared build knobs (proven) --------------------------------------------
# --enable-chrome-format=flat : bork's patcher edits loose chrome; without this
#                               the package ships omni.ja and patching fails.
# --disable-debug-symbols     : halves the gkrust LLVM codegen peak; without it
#                               gkrust OOMs on 22-32 GB boxes (hit on linux+win).
# Both are baked into each lane's mozconfig below.

log()  { printf '\033[34m[build-all]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[build-all] %s\033[0m\n' "$*" >&2; exit 1; }

# Where pulled artifacts land before publishing. Deliberately NOT named after the
# canonical floorp-<platform>-<arch>-moz-artifact.<ext> that the release pipeline
# consumes: publish-runtime-artifact.sh makes that copy itself, and when the file
# it is handed already carries the canonical name the copy is a file onto itself,
# which exits 1 and takes the publish down under `set -e`.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/bork-runtime-stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# ---------------------------------------------------------------------------
build_mac() {
  log "mac: native build on this machine"
  local base="$MAC_BUILD_DIR"
  local src="$base/bork-runtime-mac"
  [ -f "$src/mach" ] || fail "mac source missing at $src (clone bork-runtime there first)"

  log "mac: syncing $RUNTIME_BRANCH from $RUNTIME_GIT_URL"
  ( cd "$src"
    git remote set-url origin "$RUNTIME_GIT_URL" 2>/dev/null || \
      git remote add origin "$RUNTIME_GIT_URL"
    git fetch --quiet origin "$RUNTIME_BRANCH" ) \
    || fail "mac: could not fetch $RUNTIME_BRANCH"
  ( cd "$src" && git merge --ff-only FETCH_HEAD ) \
    || fail "mac: $src is not a fast-forward of origin/$RUNTIME_BRANCH — reconcile it by hand"
  local sdk; sdk="$(xcrun --sdk macosx --show-sdk-path)"
  [ -d "$sdk" ] || fail "no macOS SDK (need Xcode >= 26.4)"

  # explicit rust paths so mach never calls the (unconfigured) `rustup which`
  local tc; tc="$(rustup show home)/toolchains/$(rustup show active-toolchain | awk '{print $1}')/bin"
  ( cd "$src"
    source "$base/macbuildenv.sh"
    export RUSTC="$tc/rustc" CARGO="$tc/cargo"
    ./mach build
    ./mach package )
  # mach names the dmg after MOZ_APP_NAME, so this glob must not hardcode it —
  # it was 'floorp-*.mac.dmg' and stopped matching the moment the app was
  # renamed, after a full build and package had already run.
  local dmg; dmg="$(find "$base/obj-mac-aarch64/dist" -maxdepth 1 -name '*.mac.dmg' | head -1)"
  [ -f "$dmg" ] || fail "mac: no dmg produced"
  "$PUBLISH" mac aarch64 "$dmg" "$TAG"
}

# ---------------------------------------------------------------------------
build_linux() {
  log "linux: build on $BUILD_HOST"
  # pass the remote build dir as $1 so this stays a quoted (non-interpolated) heredoc
  log "linux: syncing $RUNTIME_BRANCH on $BUILD_HOST"
  ssh "$BUILD_HOST" "cd '$LINUX_BUILD_DIR/bork-runtime' \
    && (git remote set-url origin '$RUNTIME_GIT_URL' || git remote add origin '$RUNTIME_GIT_URL') \
    && git fetch --quiet origin '$RUNTIME_BRANCH' \
    && git merge --ff-only FETCH_HEAD" \
    || fail "linux: source sync failed on $BUILD_HOST (not a fast-forward? reconcile by hand)"

  ssh "$BUILD_HOST" "bash -s '$LINUX_BUILD_DIR'" <<'REMOTE'
set -euo pipefail
BUILD_DIR="$1"
cd "$BUILD_DIR/bork-runtime"
source "$BUILD_DIR/buildenv.sh"
export MOZCONFIG="$BUILD_DIR/mozconfig-linux-x86_64"
./mach build
./mach package
REMOTE
  # Pull the flat tarball off the build host and publish from here. mach names it
  # after MOZ_APP_NAME, so resolve the name rather than assuming a prefix — this
  # glob was 'floorp-*' and stopped matching the moment the app was renamed,
  # exactly as the mac lane's did above, and it fails only AFTER the multi-hour
  # build. A bork-named tarball here is correct output, not a fault to paper over:
  # the canonical floorp-*-moz-artifact name the release pipeline consumes is a
  # publishing concern, applied by publish-runtime-artifact.sh.
  local remote
  remote="$(ssh "$BUILD_HOST" "ls -1t '$LINUX_BUILD_DIR'/obj-linux-x86_64/dist/*.linux-x86_64.tar.xz 2>/dev/null | head -1")"
  [ -n "$remote" ] || fail "linux: no *.linux-x86_64.tar.xz under $LINUX_BUILD_DIR/obj-linux-x86_64/dist on $BUILD_HOST"
  log "linux: pulling $(basename "$remote")"
  local out="$STAGE/$(basename "$remote")"
  scp -q "$BUILD_HOST:$remote" "$out"
  [ -s "$out" ] || fail "linux: pulled tarball is empty: $remote"
  "$PUBLISH" linux x86_64 "$out" "$TAG"
}

# ---------------------------------------------------------------------------
build_windows() {
  log "windows: native build in the KVM VM (driven from $BUILD_HOST)"
  # The VM build + pull is scripted on the build host (winps runner, scheduled
  # task with RunLevel Highest for msiexec, base64-over-WinRM pull). Trigger it:
  log "windows: syncing $WIN_RUNTIME_BRANCH inside the VM"
  ssh "$BUILD_HOST" "cat > /tmp/bork-win-sync.ps1 <<'PS1'
cd C:\\derp-runtime
git remote set-url origin '$RUNTIME_GIT_URL'
git fetch --quiet origin '$WIN_RUNTIME_BRANCH'
git reset --hard FETCH_HEAD
git log --oneline -1
PS1
'$WIN_BUILD_DIR/../bob-release/tools/winrm-venv/bin/python' '$WIN_BUILD_DIR/winps95.py' < /tmp/bork-win-sync.ps1" \
    || fail "windows: VM source sync failed (branch $WIN_RUNTIME_BRANCH)"

  ssh "$BUILD_HOST" "bash '$WIN_BUILD_DIR/run-win-build.sh'" \
    || fail "windows VM build failed (see $WIN_BUILD_DIR/*.log on $BUILD_HOST)"
  # run-win-build.sh pulls the VM's zip to this fixed name, so the remote side is
  # a contract with that script rather than a glob. Stage under a neutral local
  # name so publish-runtime-artifact.sh is never handed the canonical name.
  local remote="$LINUX_BUILD_DIR/artifacts/floorp-windows-x86_64-moz-artifact.zip"
  local out="$STAGE/bork-windows-x86_64.zip"
  scp -q "$BUILD_HOST:$remote" "$out" \
    || fail "windows: no artifact at $remote on $BUILD_HOST (did run-win-build.sh finish?)"
  [ -s "$out" ] || fail "windows: pulled zip is empty: $remote"
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
log "The bork release pipeline (build-bork-packages.sh) fetches them via OWN_RUNTIME_FILES."
