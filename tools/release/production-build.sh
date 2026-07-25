#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# production-build.sh — the PRODUCTION build mode, as opposed to the normal dev
# build (feles-build stage/dev, which just runs bork locally against a runtime).
#
# Production mode does the full chain end to end:
#   1. build the Gecko runtime for each platform we ship          (build-all-runtimes.sh)
#   2. build the production feature layer                         (feles-build build --phase before-mach)
#   3. overlay the feature layer onto each runtime and package    (build-bork-packages.sh)
#   4. upload the packages to your download site ($BORK_WEB_REMOTE)  (rsync)
#
# This is deliberately a thin orchestrator over the pieces that already exist and
# are individually proven — it wires them into one "ship it" command.
#
# Usage:
#   production-build.sh [runtime-tag] [--skip-runtime] [--no-upload] [mac linux windows | all]
#   production-build.sh --site-only
#
#   <runtime-tag>  : required when building runtimes (it is the tag they publish
#                    under). With --skip-runtime it is optional and pins which
#                    published runtime to ship; omit it to ship the newest.
#
#   --skip-runtime : reuse the already-published runtime tag instead of rebuilding
#                    the Gecko runtimes (rebuild is the long part; skip when only
#                    the feature layer changed).
#   --no-upload    : build packages but do not rsync to the download site.
#   --install      : after the mac lane packages, install it to ~/Applications.
#                    Refuses while a copy is running rather than clobbering it.
#   --site-only    : publish ONLY the download page — copy, layout, assets. Runs
#                    the same page refresh and rsync the full build does, so the
#                    version subtitle, per-file sizes and sha256s are still
#                    regenerated from dist/ rather than hand-edited; it just
#                    skips rebuilding and re-uploading packages that have not
#                    changed. Takes no runtime tag and no lanes.
#
# Example (feature-layer-only ship, on the newest published runtime):
#   production-build.sh --skip-runtime all
#
# NOTE on branding: until M2 (runtimes built WITH a bork branding dir), the
# runtimes are nightly-branded and bork-branding.patch cannot apply. Visible
# branding (app name, Dock, icon) still comes from brand-mac-bundle.sh +
# bork-defaults; some internal strings read "Nightly/Floorp". Building the
# runtimes with --with-branding=browser/branding/bork closes that gap.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SITE_ONLY=0
TAG=""
if [ "${1:-}" = "--site-only" ]; then
  SITE_ONLY=1; shift || true
elif [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then
  # A leading bare word that is not a lane is the runtime tag. Optional now:
  # omitted with --skip-runtime it means "ship on the newest published runtime",
  # which is what you want almost every time and what nobody can mistype.
  case "$1" in
    mac|linux|windows|all) ;;
    *) TAG="$1"; shift ;;
  esac
fi
SKIP_RUNTIME=0
UPLOAD=1
INSTALL=0
LANES=()
for a in "$@"; do
  case "$a" in
    --skip-runtime) SKIP_RUNTIME=1 ;;
    --no-upload)    UPLOAD=0 ;;
    --install)      INSTALL=1 ;;
    mac|linux|windows) LANES+=("$a") ;;
    all) LANES=(mac linux windows) ;;
    *) echo "unknown arg: $a" >&2; exit 1 ;;
  esac
done
[ ${#LANES[@]} -gt 0 ] || LANES=(mac linux windows)

# Local infra config (web target, hosts). Copy tools/release/hosts.env.example to
# tools/release/hosts.env and fill in your own; hosts.env is gitignored. Values
# are also overridable via the environment.
HOSTS_ENV="${BORK_HOSTS_ENV:-$ROOT/tools/release/hosts.env}"
# shellcheck source=/dev/null
[ -f "$HOSTS_ENV" ] && source "$HOSTS_ENV"

WEB_REMOTE="${BORK_WEB_REMOTE:-your-web-host:/var/www/example.com/bork/downloads}"
SITE_URL="${BORK_SITE_URL:-https://example.com/bork/}"

log() { printf '\033[35m[production]\033[0m %s\n' "$*"; }

# 0. site-only: the page, nothing else. Same refresh + rsync as the upload step
# below (deliberately the same two commands, so the page can never be published
# with hand-edited sums or a stale version subtitle) minus the package upload,
# which would re-send hundreds of MB that have not changed.
if [ "$SITE_ONLY" = 1 ]; then
  log "site only — refreshing page sums, sizes and version from dist/"
  python3 "$ROOT/tools/release/update-site-sums.py"
  log "uploading the site to ${WEB_REMOTE%/downloads}"
  rsync -av "$ROOT/tools/release/site/" "${WEB_REMOTE%/downloads}/"
  log "uploaded. live at $SITE_URL"
  exit 0
fi

# 1. runtimes (the long part) — skip to reuse an already-published tag
if [ "$SKIP_RUNTIME" = 0 ]; then
  # Building runtimes means publishing under a tag, so this one cannot be
  # inferred — naming an existing release here would publish over it.
  [ -n "$TAG" ] ||
    { echo "runtime tag required when building runtimes (e.g. bork-runtime-152.0.7-3); omit it only with --skip-runtime" >&2; exit 1; }
  log "building Gecko runtimes for: ${LANES[*]} (tag $TAG)"
  "$ROOT/tools/release/build-all-runtimes.sh" "$TAG" all
elif [ -n "$TAG" ]; then
  log "reusing published runtime tag $TAG (--skip-runtime)"
else
  log "reusing the newest published runtime (--skip-runtime, no tag pinned)"
fi

# Point the release packager at our runtime tag. Empty is meaningful: it lets
# build-bork-packages.sh resolve the newest published release itself.
export BORK_OWN_RUNTIME_TAG="$TAG"

# Which runtime the mac lane ships.
#
# Unlike linux/windows, the mac lane does not consume the published tag at all —
# build-bork-packages.sh either copies $BORK_MAC_RUNTIME_APP or falls back to the
# dev tree at _dist/bin/floorp/Floorp.app. That fallback is a trap: it is whatever
# the last dev cycle left behind, so a runtime fix can be built, committed and
# published and the mac package still ships the old binary. That is exactly how a
# runtime whose XUL still registered the since-deleted SSB command-line handler
# got packaged and uploaded — it crashed on startup with only "Missing chrome or
# resource URL" to show for it.
#
# So: prefer the freshly built runtime whenever one is present, and say out loud
# which one is being shipped.
MAC_BUILD_DIR="${BORK_MAC_BUILD_DIR:-$HOME/bork-build}"
if [ -z "${BORK_MAC_RUNTIME_APP:-}" ]; then
  fresh="$(find "$MAC_BUILD_DIR/obj-mac-aarch64/dist" -maxdepth 1 -name '*.app' 2>/dev/null | head -1)"
  [ -n "$fresh" ] && export BORK_MAC_RUNTIME_APP="$fresh"
fi
if [ -n "${BORK_MAC_RUNTIME_APP:-}" ]; then
  log "mac runtime: $BORK_MAC_RUNTIME_APP (freshly built)"
else
  log "mac runtime: _dist/bin/floorp/Floorp.app (dev tree fallback — NOT a fresh build)"
fi

# 2 + 3. feature layer + overlay + package, per lane.
log "building feature layer and packaging: ${LANES[*]}"
"$ROOT/tools/release/build-bork-packages.sh" --build "${LANES[@]}"

# 3b. install the freshly packaged mac app locally (opt-in).
# Deliberately non-fatal: a failed install should not sink a build whose packages
# are already made, and refusing to overwrite a running copy is the common case.
if [ "$INSTALL" = 1 ]; then
  app="$ROOT/build/release/mac/Bork.app"
  dest="$HOME/Applications/Bork.app"
  if ! printf '%s\n' "${LANES[@]}" | grep -qx mac; then
    log "--install ignored: mac is not among the lanes (${LANES[*]})"
  elif [ ! -d "$app" ]; then
    log "--install skipped: no packaged app at $app"
  elif pgrep -f "$dest/Contents/MacOS/" >/dev/null 2>&1; then
    log "--install skipped: Bork is running from $dest — quit it and re-run to install"
  else
    log "installing $dest"
    rm -rf "$dest" && mkdir -p "$HOME/Applications" && cp -R "$app" "$dest" \
      && log "installed. launch it from ~/Applications" \
      || log "install failed (packages in dist/ are unaffected)"
  fi
fi

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

  # The page quotes a sha256 per download; without this refresh every release
  # republishes the PREVIOUS build's sums and verification fails for anyone
  # who runs it. Page goes up last, after the files it describes exist.
  log "refreshing page sums + sizes"
  python3 "$ROOT/tools/release/update-site-sums.py"
  # The whole site dir, not just index.html: the page now carries its own
  # assets/ (hero photo, screenshots, webfont) and an index shipped without
  # them renders unstyled and imageless. No --delete: downloads/ lives under
  # the same web root and must survive.
  rsync -av "$ROOT/tools/release/site/" "${WEB_REMOTE%/downloads}/"
  log "uploaded. live at $SITE_URL"
else
  log "skipped upload (--no-upload); packages in dist/"
fi

log "production build done."
