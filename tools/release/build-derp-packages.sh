#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# derp release packaging: prebuilt Floorp-runtime + production feature
# overlay -> per-platform archives. No mach, no compilation — the noraneko
# layer is platform-independent web content, so every platform ships the
# same overlay on its own runtime binary.
#
# Prereqs (mac lane and overlay source):
#   - dev servers stopped (the production build owns _dist/noraneko)
#   - `deno task feles-build build --phase before-mach` has produced
#     _dist/noraneko (run with --build to do it here)
#   - runtime archives in build/runtimes/ (see RUNTIME_TAG; downloaded
#     automatically when missing)
#
# Lanes: mac (from the local dev-validated runtime tree), linux + windows
# (from clean downloaded runtime archives + patches). Artifacts in dist/.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RUNTIME_TAG="${DERP_RUNTIME_TAG:-daily-977}"
RUNTIME_URL="https://github.com/Floorp-Projects/Floorp-runtime/releases/download/${RUNTIME_TAG}"

# Runtimes we build ourselves live in a private repo and are fetched with an
# authenticated `gh` download. Any file NOT listed in OWN_RUNTIME_FILES falls
# back to the upstream Floorp-runtime release above. As more platforms get
# built by us, add their artifact filenames to OWN_RUNTIME_FILES.
OWN_RUNTIME_REPO="${DERP_OWN_RUNTIME_REPO:-100mountains/derp-runtime}"
OWN_RUNTIME_TAG="${DERP_OWN_RUNTIME_TAG:-derp-runtime-152.0.7-1}"
OWN_RUNTIME_FILES="${DERP_OWN_RUNTIME_FILES:-floorp-linux-x86_64-moz-artifact.tar.xz}"

log() { printf '\033[34m[derp-release]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[derp-release] %s\033[0m\n' "$*" >&2; exit 1; }

# Empty a staging directory and recreate it.
#
# Plain `rm -rf X && mkdir X` loses a race that happens routinely here: if the
# directory is open in Finder, Finder writes .DS_Store back the moment rm
# empties it, and rm then fails the final rmdir with "Directory not empty".
# Retry rather than make the caller close a window to run a build.
reset_dir() {
  local dir="$1" attempt
  for attempt in 1 2 3; do
    rm -rf "$dir" 2>/dev/null && break
    sleep 1
  done
  rm -rf "$dir" || fail "could not clear $dir"
  mkdir -p "$dir"
}

# Overlay the production noraneko layer onto a runtime app root (the dir
# holding browser/ and chrome.manifest).
overlay() {
  local approot="$1"
  [ -f "$approot/chrome.manifest" ] || fail "no chrome.manifest under $approot"

  log "patching runtime files"
  local p
  for p in _dist/bin/applied_patches/*.patch; do
    patch -p0 -d "$approot" --forward --silent < "$p" \
      || fail "patch failed: $(basename "$p")"
  done

  log "overlaying noraneko content"
  rm -rf "$approot/noraneko-devdir"
  mkdir "$approot/noraneko-devdir"
  cp -RL _dist/noraneko/ "$approot/noraneko-devdir/"
  deno run -A --config deno.json tools/release/gen-noraneko-manifest.ts \
    "$approot/noraneko-devdir"
  grep -q "noraneko-devdir/noraneko.manifest" "$approot/chrome.manifest" \
    || printf '\nmanifest noraneko-devdir/noraneko.manifest\n' >> "$approot/chrome.manifest"

  local xhtml="$approot/browser/chrome/browser/content/browser/browser.xhtml"
  [ -f "$xhtml" ] || fail "browser.xhtml not found under $approot"
  grep -q "noraneko-startup" "$xhtml" || perl -i -pe \
    's|</head>|<script data-geckomixin="" async="async" src="chrome://noraneko-startup/content/chrome_root.js" type="module" /></head>|' \
    "$xhtml"

  log "applying pref overrides"
  bash static/gecko/pref/override.sh \
    "$approot/browser/defaults/preferences/firefox.js"

  # Default extension pack: written at build time by the injector into the
  # dev tree only (installDistributionPolicies targets _dist/bin), so clean
  # runtime trees need it copied in or fresh installs get no extensions.
  log "installing distribution policies"
  local policies="_dist/bin/floorp/Floorp.app/Contents/Resources/distribution/policies.json"
  [ -f "$policies" ] || fail "policies.json missing from dev tree — run stage once"
  mkdir -p "$approot/distribution"
  cp "$policies" "$approot/distribution/policies.json"

  log "installing icons"
  bash tools/release/brand-icons.sh "$approot"

  find "$approot/noraneko-devdir" -name "*.map" -delete
}

fetch_runtime() {
  local file="$1"
  mkdir -p build/runtimes
  [ -f "build/runtimes/$file" ] && return

  if printf '%s\n' $OWN_RUNTIME_FILES | grep -qxF "$file"; then
    log "downloading $file from our runtime (${OWN_RUNTIME_REPO}@${OWN_RUNTIME_TAG})"
    gh release download "$OWN_RUNTIME_TAG" --repo "$OWN_RUNTIME_REPO" \
      --pattern "$file" --dir build/runtimes \
      || fail "gh runtime download failed: $file (is gh authed for ${OWN_RUNTIME_REPO}?)"
  else
    log "downloading $file (upstream ${RUNTIME_TAG})"
    curl -sL -o "build/runtimes/$file" "${RUNTIME_URL}/${file}" \
      || fail "download failed: $file"
  fi
}

build_linux() {
  local file="floorp-linux-x86_64-moz-artifact.tar.xz"
  fetch_runtime "$file"
  log "linux: extracting"
  reset_dir build/release/linux
  tar -xJf "build/runtimes/$file" -C build/release/linux
  local approot
  approot="$(dirname "$(find build/release/linux -path '*browser/chrome/browser/content/browser/browser.xhtml' | head -1)")"
  approot="${approot%/browser/chrome/browser/content/browser}"
  [ -n "$approot" ] || fail "linux app root not found"
  overlay "$approot"
  log "linux: packing"
  mkdir -p dist/linux
  COPYFILE_DISABLE=1 tar --no-xattrs -czf dist/linux/Derp-linux-x86_64.tar.gz -C "$(dirname "$approot")" \
    "$(basename "$approot")"
  log "linux: dist/linux/Derp-linux-x86_64.tar.gz"
}

build_windows() {
  local file="floorp-windows-x86_64-moz-artifact.zip"
  fetch_runtime "$file"
  log "windows: extracting"
  reset_dir build/release/windows
  unzip -q "build/runtimes/$file" -d build/release/windows
  # moz artifact zips can nest the payload one zip deeper
  local nested
  nested="$(find build/release/windows -maxdepth 2 -name '*.zip' | head -1)"
  if [ -n "$nested" ]; then
    unzip -q "$nested" -d build/release/windows
    rm -f "$nested"
  fi
  local approot
  approot="$(dirname "$(find build/release/windows -path '*browser/chrome/browser/content/browser/browser.xhtml' | head -1)")"
  approot="${approot%/browser/chrome/browser/content/browser}"
  [ -n "$approot" ] || fail "windows app root not found"
  overlay "$approot"
  log "windows: packing"
  mkdir -p dist/windows
  (cd "$(dirname "$approot")" && zip -qr9 - "$(basename "$approot")") \
    > dist/windows/Derp-windows-x86_64.zip
  log "windows: dist/windows/Derp-windows-x86_64.zip"
}

build_mac() {
  # Assembled from the local dev-validated runtime tree (_dist/bin), which
  # already carries the applied patches and injected xhtml from the dev
  # workflow — overlay refreshes content, manifest and prefs on the copy.
  log "mac: assembling from local runtime"
  local app="build/release/mac/Derp.app"
  local res="$app/Contents/Resources"
  reset_dir build/release/mac
  cp -R _dist/bin/floorp/Floorp.app "$app"
  rm -rf "$res/noraneko-devdir" && mkdir "$res/noraneko-devdir"
  cp -RL _dist/noraneko/ "$res/noraneko-devdir/"
  deno run -A --config deno.json tools/release/gen-noraneko-manifest.ts \
    "$res/noraneko-devdir"
  find "$app" -name "*.map" -delete

  log "mac: branding"
  bash tools/release/brand-mac-bundle.sh "$app"
  # Explicit, even though the dev tree usually carries them already: relying on
  # that meant a regenerated icon set only reached the package if someone had
  # remembered to install it into _dist/bin first.
  bash tools/release/brand-icons.sh "$res"

  log "mac: signing (ad-hoc) and packing"
  codesign --force --deep -s - "$app"
  mkdir -p dist/macos
  hdiutil create -volname "Derp" -srcfolder "$app" -ov -format UDZO \
    dist/macos/Derp-macOS-universal.dmg > /dev/null
  log "mac: dist/macos/Derp-macOS-universal.dmg"
}

usage() {
  echo "usage: $0 [--build] [mac] [linux] [windows] [all]"
  exit 1
}

DO_BUILD=0
LANES=()
for arg in "$@"; do
  case "$arg" in
    --build) DO_BUILD=1 ;;
    mac|linux|windows) LANES+=("$arg") ;;
    all) LANES=(mac linux windows) ;;
    *) usage ;;
  esac
done
[ ${#LANES[@]} -gt 0 ] || usage

if [ "$DO_BUILD" = 1 ]; then
  log "production feature build (before-mach)"
  deno task feles-build build --phase before-mach
fi
[ -d _dist/noraneko ] || fail "_dist/noraneko missing — run with --build"

for lane in "${LANES[@]}"; do "build_$lane"; done
log "done"
