#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# bork release packaging: prebuilt Floorp-runtime + production feature
# overlay -> per-platform archives. No mach, no compilation — the noraneko
# layer is platform-independent web content, so every platform ships the
# same overlay on its own runtime binary.
#
# Prereqs (mac lane and overlay source):
#   - dev servers stopped (the production build owns _dist/noraneko)
#   - `deno task feles-build build --phase before-mach` has produced
#     _dist/noraneko (run with --build to do it here)
#   - runtime archives in build/runtimes/ (see OWN_RUNTIME_TAG; downloaded
#     automatically when missing)
#
# Lanes: mac (from the local dev-validated runtime tree), linux + windows
# (from clean downloaded runtime archives + patches). Artifacts in dist/.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Local infra config (site URL for the update manifest); hosts.env is gitignored.
HOSTS_ENV="${BORK_HOSTS_ENV:-$ROOT/tools/release/hosts.env}"
# shellcheck source=/dev/null
[ -f "$HOSTS_ENV" ] && source "$HOSTS_ENV"
SITE_URL="${BORK_SITE_URL:-https://example.com/bork/}"

# Every shipped platform's runtime is built by us and lives on shithub
# (self-hosted Forgejo) as a public release, fetched over plain HTTPS — no auth,
# no `gh`, no GitHub. All runtime files come from this one repo/tag.
FORGEJO_HOST="${BORK_FORGEJO_HOST:-shithub.space}"
OWN_RUNTIME_REPO="${BORK_OWN_RUNTIME_REPO:-n01/bork-runtime}"
OWN_RUNTIME_TAG="${BORK_OWN_RUNTIME_TAG:-bork-runtime-152.0.7-1}"

log() { printf '\033[34m[bork-release]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[bork-release] %s\033[0m\n' "$*" >&2; exit 1; }

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
  # Same for distribution/extensions/ — the 10 built-in theme XPIs
  # (installThemePack); without the copy, fresh installs get no themes.
  log "installing distribution policies + theme pack"
  local dist_src="_dist/bin/floorp/Floorp.app/Contents/Resources/distribution"
  [ -f "$dist_src/policies.json" ] ||
    fail "policies.json missing from dev tree — run stage once"
  [ -d "$dist_src/extensions" ] ||
    fail "distribution/extensions (theme pack) missing from dev tree — run stage once"
  mkdir -p "$approot/distribution"
  cp "$dist_src/policies.json" "$approot/distribution/policies.json"
  cp -R "$dist_src/extensions" "$approot/distribution/extensions"

  log "installing icons"
  bash tools/release/brand-icons.sh "$approot"

  # Vendor name: the published 152.0.7-1 runtimes were compiled before the
  # runtime source vendor fix (bork-runtime 6d606025f65: -vendor-short-name and
  # MOZ_APP_VENDOR -> Bork), so their loose brand.ftl still says "Ablaze" — which
  # the About dialog renders as "Bork is designed by Ablaze". These branding files
  # are loose (chrome-format=flat), so correct them here until the runtimes are
  # rebuilt from the fixed source (mac natively; linux/windows on the build PC).
  log "correcting vendor name (Ablaze -> Bork)"
  find "$approot/browser" \( -name brand.ftl -o -name brand.properties \) \
    -exec perl -i -pe 's/Ablaze/Bork/g' {} +
  # application.ini too (Vendor=Ablaze): shown by about:support and used in
  # the profile path on Windows/Linux (AppData\Vendor\Name, ~/.vendor) — fine
  # to change pre-release, but a profile-moving change once users exist.
  # macOS profiles key on the app name only, so existing mac profiles keep.
  [ -f "$approot/application.ini" ] &&
    perl -i -pe 's/^Vendor=Ablaze$/Vendor=Bork/' "$approot/application.ini"

  strip_ai_bundle "$approot"

  find "$approot/noraneko-devdir" -name "*.map" -delete
}

# The local AI inference stack: ONNX Runtime, HuggingFace transformers,
# llama.cpp (wllama), an OpenAI client, and the model-hub downloader that
# feeds them. bork ships none of it — the prefs are off, but off is not the
# same as absent, and we do not want an LLM runtime sitting on disk.
#
# Translation survives this: it uses Bergamot, downloaded separately from
# RemoteSettings, and imports exactly two files from the ml/ directory —
# AIFeature.sys.mjs (the on/off gate it inherits) and EngineProcess.sys.mjs
# (the shared process manager). Both are kept. Everything EngineProcess
# says about the deleted modules is comments in an engine-id table, not
# imports, so nothing translation touches goes missing.
strip_ai_bundle() {
  local approot="$1"
  local ml="$approot/chrome/toolkit/content/global/ml"
  [ -d "$ml" ] || return 0
  log "removing the AI inference bundle"
  local before
  before="$(du -sk "$ml" | cut -f1)"
  find "$ml" -mindepth 1 -maxdepth 1 \
    ! -name AIFeature.sys.mjs ! -name EngineProcess.sys.mjs -exec rm -rf {} +
  rm -f "$approot/actors/MLEngineChild.sys.mjs" \
        "$approot/actors/MLEngineParent.sys.mjs"
  log "AI bundle: ${before}K -> $(du -sk "$ml" | cut -f1)K (translation kept)"
}

# Resolve a runtime artifact to a local path, downloading if we do not have it.
# Sets RUNTIME_FILE to the path the caller should use.
#
# The cache is keyed by TAG as well as filename. It used to be filename only,
# which meant a rebuilt runtime published under a new tag was silently ignored:
# the old artifact was already sitting in build/runtimes/ under the same
# canonical name, so the download was skipped and the package shipped the
# superseded binary. That is how a runtime carrying a startup-crash fix could be
# built, published, and still not reach the package.
fetch_runtime() {
  local file="$1" tag="$OWN_RUNTIME_TAG" dir
  dir="build/runtimes/$tag"
  mkdir -p "$dir"
  RUNTIME_FILE="$dir/$file"
  [ -f "$RUNTIME_FILE" ] && { log "using cached $file ($tag)"; return; }

  log "downloading $file from our runtime (${OWN_RUNTIME_REPO}@${tag} on ${FORGEJO_HOST})"
  # Forgejo/Gitea public release asset URL — same shape as GitHub's, no auth.
  curl -fsSL -o "$RUNTIME_FILE" \
    "https://${FORGEJO_HOST}/${OWN_RUNTIME_REPO}/releases/download/${tag}/${file}" \
    || fail "runtime download failed: $file (is ${OWN_RUNTIME_REPO}@${tag} published on ${FORGEJO_HOST}?)"
  [ -s "$RUNTIME_FILE" ] || fail "downloaded artifact is empty: $RUNTIME_FILE"
}

build_linux() {
  local file="floorp-linux-x86_64-moz-artifact.tar.xz"
  fetch_runtime "$file"
  log "linux: extracting"
  reset_dir build/release/linux
  tar -xJf "$RUNTIME_FILE" -C build/release/linux
  local approot
  approot="$(dirname "$(find build/release/linux -path '*browser/chrome/browser/content/browser/browser.xhtml' | head -1)")"
  approot="${approot%/browser/chrome/browser/content/browser}"
  [ -n "$approot" ] || fail "linux app root not found"
  overlay "$approot"
  log "linux: packing"
  mkdir -p dist/linux
  COPYFILE_DISABLE=1 tar --no-xattrs -czf dist/linux/Bork-linux-x86_64.tar.gz -C "$(dirname "$approot")" \
    "$(basename "$approot")"
  log "linux: dist/linux/Bork-linux-x86_64.tar.gz"
}

build_windows() {
  local file="floorp-windows-x86_64-moz-artifact.zip"
  fetch_runtime "$file"
  log "windows: extracting"
  reset_dir build/release/windows
  unzip -q "$RUNTIME_FILE" -d build/release/windows
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
    > dist/windows/Bork-windows-x86_64.zip
  log "windows: dist/windows/Bork-windows-x86_64.zip"
}

build_mac() {
  local app="build/release/mac/Bork.app"
  local res="$app/Contents/Resources"
  reset_dir build/release/mac

  if [ -n "${BORK_MAC_RUNTIME_APP:-}" ]; then
    # Ship a runtime WE just compiled: copy the raw runtime app and run the same
    # overlay() the linux/windows lanes use (patches + noraneko + xhtml + prefs +
    # policies + icons + vendor). A freshly built runtime is already bork-branded
    # with the correct compiled vendor, so no loose-file vendor patch is needed.
    [ -d "$BORK_MAC_RUNTIME_APP" ] || fail "BORK_MAC_RUNTIME_APP not found: $BORK_MAC_RUNTIME_APP"
    log "mac: assembling from fresh runtime ($BORK_MAC_RUNTIME_APP)"
    # -L, not -R alone: mach's dist/*.app is a symlink FARM (~7k links) pointing
    # back into the runtime source checkout, because chrome-format=flat leaves
    # loose chrome as links rather than copies. Copying the links and then
    # patching writes straight through them into the Gecko source tree — which
    # corrupts the checkout and makes the NEXT build die on "Ignoring previously
    # applied (or reversed) patch". Dereference so the package owns real files.
    cp -RL "$BORK_MAC_RUNTIME_APP" "$app"
    [ -f "$res/chrome.manifest" ] || fail "mac: no chrome.manifest under $res (unexpected runtime layout)"
    overlay "$res"
    find "$app" -name "*.map" -delete
    log "mac: branding"
    bash tools/release/brand-mac-bundle.sh "$app"
  else
    # Assembled from the local dev-validated runtime tree (_dist/bin), which
    # already carries the applied patches and injected xhtml from the dev
    # workflow — overlay refreshes content, manifest and prefs on the copy.
    log "mac: assembling from local runtime"
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

    # This lane assembles from the local runtime tree and never routes through
    # overlay(), so apply the same loose-file vendor correction here: the tree's
    # brand.ftl still says "Ablaze" ("Bork is designed by Ablaze" in About) until
    # the mac runtime is rebuilt from the fixed source.
    log "mac: correcting vendor name (Ablaze -> Bork)"
    find "$res/browser" \( -name brand.ftl -o -name brand.properties \) \
      -exec perl -i -pe 's/Ablaze/Bork/g' {} +
  fi

  log "mac: signing (ad-hoc) and packing"
  # Strip resource forks / Finder info / quarantine xattrs first — codesign
  # rejects them ("resource fork, Finder information, or similar detritus not
  # allowed"). A dmg-sourced runtime carries them; the _dist/bin path is already
  # cleaned by the dev initializer, but doing it here is harmless and idempotent.
  xattr -cr "$app"
  codesign --force --deep -s - "$app"
  mkdir -p dist/macos
  hdiutil create -volname "Bork" -srcfolder "$app" -ov -format UDZO \
    dist/macos/Bork-macOS-universal.dmg > /dev/null
  log "mac: dist/macos/Bork-macOS-universal.dmg"
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

# The in-browser update check (chrome/common/update-check) reads
# updates/update.xml from this repo's main branch — refresh it from
# package.json so a published package and the manifest can't drift.
# It only announces the release once committed and pushed.
PKG_VERSION="$(perl -ne 'print $1 if /"version":\s*"([^"]+)"/' package.json)"
cat > updates/update.xml <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<updates>
  <update type="minor"
          displayVersion="${PKG_VERSION}"
          appVersion2="${PKG_VERSION}"
          detailsURL="${SITE_URL}"/>
</updates>
EOF
log "updates/update.xml -> ${PKG_VERSION} (commit + push to announce the release)"
log "done"
