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
#   - runtime archives in build/runtimes/<tag>/ — downloaded automatically when
#     missing, from the newest published release unless BORK_OWN_RUNTIME_TAG
#     pins an older one (see resolve_runtime_tag)
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
# Empty means "whatever is newest on the release host", resolved at run time by
# resolve_runtime_tag below. Set BORK_OWN_RUNTIME_TAG to pin an older one.
#
# This used to be a hardcoded tag and it went stale twice over: first naming a
# runtime that had been superseded, then one that had been deleted outright, so
# every linux/windows build 404'd on the download until someone passed the env
# var by hand. A default that names a specific release is wrong the moment the
# next one is published — ask instead.
OWN_RUNTIME_TAG="${BORK_OWN_RUNTIME_TAG:-}"

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

  # Distribution config + add-on pack. The injector only ever writes these into
  # the dev tree (it targets _dist/bin), so clean runtime trees need them copied
  # in. refresh_distribution (called once before the lanes) has already rebuilt
  # the source directory. NO policies.json ships, ever: any active enterprise
  # policy makes every profile display "Your browser is being managed by your
  # organisation" — search default travels in distribution.ini instead, and the
  # default add-ons (themes + uBO + Dark Reader) are ordinary removable
  # installs from distribution/extensions.
  log "installing distribution config + add-on pack"
  local dist_src="_dist/bin/floorp/Floorp.app/Contents/Resources/distribution"
  [ -f "$dist_src/distribution.ini" ] ||
    fail "distribution.ini missing from dev tree — run 'deno task feles-build misc distribution'"
  [ -d "$dist_src/extensions" ] ||
    fail "distribution/extensions (add-on pack) missing from dev tree — run 'deno task feles-build misc distribution'"
  mkdir -p "$approot/distribution"
  cp "$dist_src/distribution.ini" "$approot/distribution/distribution.ini"
  rm -f "$approot/distribution/policies.json"
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
  neuter_stock_updater "$approot/application.ini"

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

# Newest published tag, asked for once and reused. Called from fetch_runtime
# rather than at startup so a mac-only build — which consumes no published
# artifact — never needs the network for this.
#
# No fallback to a baked-in tag on failure, deliberately: we cannot know what is
# published without asking, and quietly packaging some older runtime we happen to
# name in this file is the exact failure being fixed. Stop and let the operator
# pin one, which also covers building offline from build/runtimes/.
resolve_runtime_tag() {
  if [ -n "$OWN_RUNTIME_TAG" ]; then return 0; fi

  log "resolving newest runtime tag (${OWN_RUNTIME_REPO} on ${FORGEJO_HOST})"
  # Forgejo/Gitea REST, same shape as GitHub's: newest non-draft, non-prerelease.
  local api="https://${FORGEJO_HOST}/api/v1/repos/${OWN_RUNTIME_REPO}/releases/latest"
  local json=""
  json="$(curl -fsSL --max-time 30 "$api" 2>/dev/null)" || json=""
  OWN_RUNTIME_TAG="$(printf '%s' "$json" |
    perl -ne 'if (/"tag_name"\s*:\s*"([^"]+)"/) { print $1; last }')"

  [ -n "$OWN_RUNTIME_TAG" ] || fail "could not resolve the newest runtime tag from ${FORGEJO_HOST} (${OWN_RUNTIME_REPO}) — pass BORK_OWN_RUNTIME_TAG=<tag> to pin one"
  log "runtime tag: $OWN_RUNTIME_TAG (newest published)"
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
  resolve_runtime_tag
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

# The runtimes ship with the STOCK Mozilla updater aimed at
# aus5.mozilla.org — a live server that can genuinely answer for a
# Firefox-shaped product, which is how "Bork is being updated by another
# instance" appeared: the built-in updater engaging for real. bork
# updates by its own site notification + manual download only, so point
# the built-in machinery at our static "no updates" answer instead
# (tools/release/site/aus/update.xml). Template parameters are dropped
# on purpose — one static file answers every version.
neuter_stock_updater() {
  local ini="$1"
  [ -f "$ini" ] || return 0
  perl -i -pe \
    's|^URL=https://aus\d*\.mozilla\.org/.*$|URL=https://borkbrowser.online/aus/update.xml|' \
    "$ini"
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

  # AppImage: the same tree again as one self-mounting executable. An
  # AppImage is literally `type-2 runtime blob + squashfs(AppDir)`
  # concatenated — the runtime mounts its own tail and execs AppRun — so
  # macOS builds it with just mksquashfs (brew install squashfs). Blob is
  # vendored + pinned in tools/release/appimage/ (see its README).
  local airt="tools/release/appimage/runtime-x86_64"
  if command -v mksquashfs >/dev/null 2>&1 && [ -f "$airt" ]; then
    log "linux: building AppImage"
    local appdir=build/release/linux/Bork.AppDir
    rm -rf "$appdir"
    mkdir -p "$appdir"
    cp -R "$approot" "$appdir/bork"
    cat > "$appdir/AppRun" <<'APPRUN'
#!/bin/sh
# An AppImage mounts itself at a fresh /tmp/.mount_XXXXXX on every run, and
# Gecko keys its profile to a hash of the directory it is installed in. So
# every launch looked like a brand-new installation and got a brand-new empty
# profile: tabs, workspaces, history and logins all "lost" each time, and
# nothing the user did would stick. MOZ_LEGACY_PROFILES turns that
# per-install keying off and uses the plain default profile from
# profiles.ini, which is the only thing that makes sense for a build whose
# path is different every time it starts.
MOZ_LEGACY_PROFILES=1
export MOZ_LEGACY_PROFILES
# "Set as default browser" writes a mimetype association naming a .desktop
# file. Gecko has to agree with the entry we install about what that file is
# called, or it writes an association pointing at nothing and silently does
# nothing at all.
MOZ_DESKTOP_FILE_NAME=bork.desktop
export MOZ_DESKTOP_FILE_NAME
HERE="$(dirname "$(readlink -f "$0")")"

# Offer to put bork in the applications menu, once.
#
# Runs SYNCHRONOUSLY, before the browser. It used to be backgrounded and the
# entry never appeared: the answer arrives after the browser has started, and
# by then the squashfs the icon is copied from can be gone and the shell that
# knew $APPIMAGE has been replaced by exec. A second of delay at startup is
# worth a shortcut that exists.
bork_offer_desktop_entry() {
  apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  icons="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/128x128/apps"
  state="${XDG_DATA_HOME:-$HOME/.local/share}/bork"

  target="${APPIMAGE:-$ARGV0}"
  case "$target" in /*) ;; *) target="$(readlink -f "$target" 2>/dev/null)" ;; esac
  [ -n "$target" ] && [ -f "$target" ] || return 0

  [ -f "$state/no-desktop-entry" ] && return 0
  # NOT "the entry file exists, so there is nothing to do". That was the bug
  # behind four versions of fixes that changed nothing: the first build to
  # write the entry made every later build return here, so the menu refresh,
  # the icon and the corrected Exec line never ran on the machines that
  # already had a broken entry — and the prompt never appeared again either.
  # Stamp what was installed, and redo the install when this number moves.
  rev=4
  [ "$(cat "$state/desktop-entry-rev" 2>/dev/null)" = "$rev" ] && return 0
  # The .deb puts its entry in /usr/share/applications; two files both named
  # bork.desktop would compete over which one "default browser" means.
  IFS=:
  for d in ${XDG_DATA_DIRS:-/usr/local/share:/usr/share}; do
    if [ -f "$d/applications/bork.desktop" ]; then
      unset IFS
      return 0
    fi
  done
  unset IFS

  # Copied while the image is certainly still mounted.
  mkdir -p "$apps" "$icons" "$state" 2>/dev/null || return 0
  cp "$HERE/bork.png" "$icons/bork.png" 2>/dev/null

  question="Add Bork to your applications menu?

It will appear with the other browsers, keep its icon, and can be set as your default browser."
  if command -v zenity >/dev/null 2>&1; then
    zenity --question --title="Bork" --text="$question" --ok-label="Add" --cancel-label="No thanks" >/dev/null 2>&1
    answer=$?
  elif command -v kdialog >/dev/null 2>&1; then
    kdialog --title "Bork" --yesno "$question" >/dev/null 2>&1
    answer=$?
  else
    # No dialog tool: write it rather than leave the user with no shortcut and
    # no way to ask for one.
    answer=0
  fi

  if [ "$answer" -ne 0 ]; then
    : > "$state/no-desktop-entry"
    return 0
  fi

  cat > "$apps/bork.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Bork
Comment=A compact Firefox fork
Exec=$target %u
Icon=$icons/bork.png
Version=1.0
Categories=Network;WebBrowser;
StartupWMClass=bork
MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;
Terminal=false
DESKTOP

  # GNOME ignores a launcher it does not trust, silently — the entry is there
  # and nothing shows it. Both marks are needed.
  chmod +x "$apps/bork.desktop" 2>/dev/null
  command -v gio >/dev/null 2>&1 &&
    gio set "$apps/bork.desktop" metadata::trusted true >/dev/null 2>&1
  command -v update-desktop-database >/dev/null 2>&1 &&
    update-desktop-database "$apps" >/dev/null 2>&1

  # Menus keep their own caches and will not show a new launcher until told.
  # Every one of these is a no-op where its desktop is not installed, so run
  # them all rather than guessing which desktop this is.
  command -v xdg-desktop-menu >/dev/null 2>&1 &&
    xdg-desktop-menu forceupdate >/dev/null 2>&1
  command -v gtk-update-icon-cache >/dev/null 2>&1 &&
    gtk-update-icon-cache -q -f -t "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" \
      >/dev/null 2>&1
  for k in kbuildsycoca6 kbuildsycoca5 kbuildsycoca; do
    command -v "$k" >/dev/null 2>&1 && "$k" --noincremental >/dev/null 2>&1 && break
  done

  echo "$rev" > "$state/desktop-entry-rev" 2>/dev/null
  return 0
}

bork_offer_desktop_entry

exec "$HERE/bork/bork" "$@"
APPRUN
    chmod +x "$appdir/AppRun"
    cat > "$appdir/bork.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Bork
Exec=bork %u
Icon=bork
Categories=Network;WebBrowser;
StartupWMClass=bork
MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;
DESKTOP
    cp browser-features/branding/icon128.png "$appdir/bork.png"
    cp browser-features/branding/icon128.png "$appdir/.DirIcon"
    local sqfs=build/release/linux/bork.squashfs
    rm -f "$sqfs"
    mksquashfs "$appdir" "$sqfs" -root-owned -noappend -no-xattrs -quiet \
      -comp zstd -b 128K || fail "mksquashfs failed"
    cat "$airt" "$sqfs" > dist/linux/Bork-linux-x86_64.AppImage
    chmod +x dist/linux/Bork-linux-x86_64.AppImage
    rm -f "$sqfs"
    log "linux: dist/linux/Bork-linux-x86_64.AppImage"
  else
    log "linux: SKIPPED AppImage (needs mksquashfs + tools/release/appimage/runtime-x86_64)"
  fi

  # .deb: for people who do not want to know what an AppImage is. Double-click,
  # installed, icon in the menu, works as the default browser, removable with
  # the package manager — none of which the AppImage gives you for free.
  #
  # Built by hand rather than with dpkg-deb, which does not exist on macOS: a
  # .deb IS an ar archive of debian-binary + control.tar.gz + data.tar.gz, in
  # that order, and ar and tar are both here.
  log "linux: building .deb"
  local debver debroot debtmp
  debver="$(perl -ne 'print $1 if /"version":\s*"([^"]+)"/' package.json)"
  debtmp="build/release/linux/deb"
  debroot="$debtmp/root"
  rm -rf "$debtmp"
  mkdir -p "$debroot/opt/bork" "$debroot/usr/bin" \
           "$debroot/usr/share/applications" \
           "$debroot/usr/share/icons/hicolor/128x128/apps" \
           "$debtmp/control"

  cp -R "$approot"/. "$debroot/opt/bork/"
  cp browser-features/branding/icon128.png \
     "$debroot/usr/share/icons/hicolor/128x128/apps/bork.png"
  ln -sf /opt/bork/bork "$debroot/usr/bin/bork"

  cat > "$debroot/usr/share/applications/bork.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Bork
Comment=A compact Firefox fork
Exec=/opt/bork/bork %u
Icon=bork
Categories=Network;WebBrowser;
StartupWMClass=bork
MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;
Terminal=false
DESKTOP

  local installed_kb
  installed_kb="$(du -sk "$debroot" | cut -f1)"
  cat > "$debtmp/control/control" <<CONTROL
Package: bork
Version: $debver
Section: web
Priority: optional
Architecture: amd64
Installed-Size: $installed_kb
Maintainer: bork <hello@borkbrowser.online>
Homepage: https://borkbrowser.online/
Depends: libgtk-3-0, libdbus-glib-1-2, libxt6, libasound2 | libasound2t64
Description: bork browser
 A compact fork of Floorp 12 (Firefox 152). Keeps Manifest V2 so the full
 uBlock Origin still works, imports Vivaldi workspaces, and ships no AI
 features or telemetry.
CONTROL

  # Register as an alternative browser so "default browser" works, and refresh
  # the menu database — the two things a user would otherwise do by hand.
  cat > "$debtmp/control/postinst" <<'POSTINST'
#!/bin/sh
set -e
update-alternatives --install /usr/bin/x-www-browser x-www-browser /opt/bork/bork 100 || true
update-desktop-database -q /usr/share/applications 2>/dev/null || true
POSTINST
  cat > "$debtmp/control/prerm" <<'PRERM'
#!/bin/sh
set -e
update-alternatives --remove x-www-browser /opt/bork/bork || true
PRERM
  chmod 0755 "$debtmp/control/postinst" "$debtmp/control/prerm"

  printf '2.0\n' > "$debtmp/debian-binary"
  ( cd "$debtmp/control" && tar czf ../control.tar.gz ./control ./postinst ./prerm )
  ( cd "$debroot" && tar czf ../data.tar.gz ./opt ./usr )
  # Written by hand rather than with ar: macOS ships BSD ar, which inserts a
  # __.SYMDEF symbol table member. That makes a valid static library and an
  # invalid .deb — dpkg wants exactly debian-binary, control.tar.gz,
  # data.tar.gz, in that order, and nothing else. The format is a magic line
  # and a 60-byte header per member, so it is less trouble to emit it than to
  # coax a toolchain difference into behaving.
  ( cd "$debtmp" && python3 - "Bork-linux-x86_64.deb" <<'ARPY'
import sys, os
out = sys.argv[1]
members = ["debian-binary", "control.tar.gz", "data.tar.gz"]
with open(out, "wb") as deb:
    deb.write(b"!<arch>\n")
    for name in members:
        data = open(name, "rb").read()
        header = (
            name.ljust(16)[:16]
            + str(int(os.path.getmtime(name))).ljust(12)[:12]
            + "0".ljust(6)      # uid
            + "0".ljust(6)      # gid
            + "100644".ljust(8) # mode
            + str(len(data)).ljust(10)[:10]
            + "`\n"
        ).encode()
        deb.write(header)
        deb.write(data)
        if len(data) % 2:      # members are padded to an even offset
            deb.write(b"\n")
ARPY
  )
  # Unversioned filename like its siblings: the download page links one
  # stable URL, and the version lives in the package metadata where dpkg
  # reads it from.
  mv "$debtmp/Bork-linux-x86_64.deb" "dist/linux/Bork-linux-x86_64.deb"
  rm -rf "$debtmp"
  log "linux: dist/linux/Bork-linux-x86_64.deb ($debver)"
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
    neuter_stock_updater "$res/application.ini"
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

# Rebuild _dist/bin/.../distribution/ (policies.json + theme XPIs) from source
# before any lane reads it. Every lane ships that directory: linux/windows copy
# it in overlay(), and the mac lane inherits it wholesale with _dist/bin's app
# bundle. It is a build output, so whatever a past stage left there is not
# necessarily what the tree now says — and trusting it shipped Ghostery and
# Privacy Badger in every package for four days after they were deleted from
# injector.ts, alongside 10 pre-rebrand `@themes.derp` XPIs. Package from
# source; never from an artifact you cannot date.
log "regenerating distribution policies + theme pack from source"
deno task feles-build misc distribution ||
  fail "could not regenerate the distribution dir from source"

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
