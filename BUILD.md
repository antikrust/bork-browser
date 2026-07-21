# Building derp

derp is two repositories:

| Repo | What it is | Where it's built |
| --- | --- | --- |
| **`100mountains/derp`** (this repo) | The feature layer — SolidJS/React chrome, patches, release tooling. | Your dev machine, in seconds. |
| **`100mountains/derp-runtime`** | A fork of Floorp's Noraneko runtime = patched mozilla-central (Gecko). | A real build host per platform. Hours, not seconds. |

A finished derp is the **feature layer overlaid onto a compiled runtime**. Day-to-day you only
touch the feature layer (`deno task feles-build stage`). You rebuild the runtime only when you
need engine-level changes (branding, a Gecko patch, a new Firefox version).

There are three build surfaces, all wired up:

1. **Runtime** — compile Gecko per platform → publish artifacts to the `derp-runtime` GitHub release.
2. **Feature layer** — `feles-build` (dev) or `build --phase before-mach` (production assets).
3. **Release packages** — overlay the feature layer onto each runtime → installable apps → upload to your download site.

### Infra config — `hosts.env`

The release scripts do not hardcode any host or path. Copy the template and fill in your own:

```bash
cp tools/release/hosts.env.example tools/release/hosts.env
$EDITOR tools/release/hosts.env      # gitignored — never committed
```

| Variable | What it is |
| --- | --- |
| `DERP_BUILD_HOST` | Linux build host — an SSH alias or `user@host`. |
| `DERP_MAC_BUILD_DIR` | Runtime build tree on this Mac. |
| `DERP_LINUX_BUILD_DIR` | Runtime build tree on the Linux host. |
| `DERP_WIN_BUILD_DIR` | Windows-VM helper scripts, on the Linux host. |
| `DERP_WEB_REMOTE` | rsync target for the download site (`host:/path`). |
| `DERP_SITE_URL` | Public URL the packages end up at. |
| `DERP_RUNTIME_REPO` | Repo the self-built runtime artifacts are published to. |

Each is also overridable directly via the environment.

---

## 1. Building the runtime

Runtimes are compiled Gecko. You cannot skip this with an SDK — Gecko only ships as a whole
browser, so a fork must patch mozilla-central and build it. `--enable-artifact-builds` does NOT
apply here; the runtime mozconfigs are full C++ compiles.

### Build hosts

One host per platform. Reference specs (what these recipes were proven on, and the timings you
can expect):

| Platform | Host | Notes |
| --- | --- | --- |
| macOS aarch64 | this Mac (Apple Silicon) | native; needs **Xcode ≥ 26.4** (Gecko hard-requires SDK 26.4). Put the build tree on a roomy volume (`DERP_MAC_BUILD_DIR`) — the objdir is tens of GB. |
| Linux x86_64 | `DERP_BUILD_HOST` (e.g. a quad-core, 32 GB box) | build tree + all state under `DERP_LINUX_BUILD_DIR`, ideally on a data disk with room. |
| Windows x86_64 | a KVM VM on the Linux host (≈22 GB RAM, 150 GB disk) | driven over WinRM; helpers under `DERP_WIN_BUILD_DIR`. |

### Shared build knobs (in every mozconfig)

```
ac_add_options --with-app-name=derp            # binary + profile (unix)
ac_add_options --with-app-basename=Derp        # Services.appinfo.name, macOS profile dir
ac_add_options --with-branding=browser/branding/derp
ac_add_options --enable-chrome-format=flat     # REQUIRED — derp's patcher edits loose chrome;
                                               #   without this you get omni.ja and patching fails
ac_add_options --disable-debug-symbols         # halves gkrust's memory peak (see gotchas)
```

`MOZ_APP_PROFILE` (Derp) and `MOZ_APP_VENDOR` (Derp) are set in
`.github/assets/config/moz.configure` in derp-runtime; `MOZ_APP_UA_NAME` stays
`Firefox` (web-compat UA). Vendor was Ablaze until derp-runtime `6d606025f65` — a runtime
published before that carries the old compiled/loose vendor, so the packager corrects the loose
`brand.ftl`/`brand.properties` (see §2+3) until the runtime is rebuilt.

### Runtime branding lives in derp-runtime

Building as "Derp" is entirely the runtime's job (there is no post-build branding patch):
`browser/branding/derp/` (name via `configure.sh` + `brand.ftl`/`brand.properties`), the mozconfig
app-name/basename/branding, and the L10n patch below. Retiring the old `derp-branding.patch` from
the feature layer depended on this.

> **One-line landmine:** Floorp patches the L10n engine (`intl/l10n/Localization.cpp` + the rust
> ffi, via `.github/patches/upstream/LocalizationCpp.patch` / `localizeFfiLib.patch`) to rewrite
> `"Firefox"→"Floorp"` on every localized string; for derp these are repointed to `"Firefox"→"Derp"`, which is what makes non-en-US locales (Mozilla langpacks say "Firefox") render as Derp.

### macOS (native)

Source at `$DERP_MAC_BUILD_DIR/derp-runtime-mac`, env in `$DERP_MAC_BUILD_DIR/macbuildenv.sh`
(redirects `MOZBUILD_STATE_PATH`, `TMPDIR` onto the build volume). mozconfig adds
`--with-macos-sdk=$(xcrun --show-sdk-path)`.

```bash
source macbuildenv.sh
export RUSTC=".../rustc" CARGO=".../cargo"   # explicit — mach's `rustup which` fails in a detached shell
cd derp-runtime-mac
./mach build && ./mach package
```

~11 min on an M4. Output: `obj-mac-aarch64/dist/derp-<ver>.en-US.mac.dmg`.

### Linux (on `DERP_BUILD_HOST`)

Source at `$DERP_LINUX_BUILD_DIR/derp-runtime`, env `$DERP_LINUX_BUILD_DIR/buildenv.sh` (redirects
mozbuild/rustup/cargo/ccache/TMPDIR onto the data disk — **required** if `/` is tight). First time:
`./mach --no-interactive bootstrap --application-choice browser`, and add a 32 GB swapfile on the
build disk (see gotchas).

```bash
ssh "$DERP_BUILD_HOST"
source "$DERP_LINUX_BUILD_DIR/buildenv.sh"
export MOZCONFIG="$DERP_LINUX_BUILD_DIR/mozconfig-linux-x86_64"
cd "$DERP_LINUX_BUILD_DIR/derp-runtime"
git apply .github/patches/upstream/*.patch     # if not already applied (see gotcha)
./mach build && ./mach package
```

~25–45 min. Output: `obj-linux-x86_64/dist/derp-<ver>.en-US.linux-x86_64.tar.xz`.

### Windows (in the KVM VM, over WinRM)

Driven from the Linux host via a small pywinrm runner (`winps.py` — reads the VM admin password
from a local file, runs PowerShell over WinRM). Source at `C:\derp-runtime`, objdir `C:\derp-obj`.
Toolchain: VS Build Tools 2022 + MozillaBuild + Rust msvc. **Run the build via an elevated
scheduled task** — mach bootstrap's SDK unpack uses `msiexec`, which fails 1603 under a plain
WinRM session-0 token:

```powershell
Register-ScheduledTask -TaskName derpbuild -Action (New-ScheduledTaskAction -Execute cmd.exe -Argument "/c C:\derp-build.bat") `
  -Principal (New-ScheduledTaskPrincipal -UserId Administrator -LogonType Password -RunLevel Highest) ...
Start-ScheduledTask -TaskName derpbuild
```

`derp-build.bat` sets `MOZILLABUILD`, runs `mach build` then `mach package`. ~100 min on the VM.
Output: `C:\derp-obj\dist\derp-<ver>.en-US.win64.zip`. Pull it out with
`$DERP_WIN_BUILD_DIR/pull_artifact.py` (base64 over WinRM).

### Publishing runtimes

```bash
tools/release/publish-runtime-artifact.sh <platform> <arch> <local-artifact> <tag>
# integrity-checks, names it canonically (floorp-<plat>-moz-artifact.*), uploads to derp-runtime release
```

The release pipeline fetches these via `OWN_RUNTIME_FILES` in `build-derp-packages.sh`.

---

## 2 + 3. Feature layer + release packages

Once the runtimes are published:

```bash
# packages all three onto our runtimes, uploads to your download site
tools/release/production-build.sh <runtime-tag> --skip-runtime all
```

Or the pieces directly — `tools/release/build-derp-packages.sh [--build] mac linux windows`:
- **mac** assembles from the local `_dist/bin/floorp/Floorp.app` (populate it first with a
  `feles-build stage` against the mac runtime), overlays `_dist/noraneko`, brands, ad-hoc signs, DMGs.
- **linux/windows** `fetch_runtime` the published artifact (set `DERP_OWN_RUNTIME_TAG=<tag>`),
  extract, overlay the 12 patches (`_dist/bin/applied_patches`) + `noraneko-devdir`, repack.

Outputs land in `dist/{macos,linux,windows}/`; `production-build.sh` rsyncs them to
`$DERP_WEB_REMOTE` with `SHA256SUMS.txt`, live at `$DERP_SITE_URL`.

### Full-automation orchestrator

`tools/release/build-all-runtimes.sh <tag> all` builds all three runtimes end-to-end (mac native,
linux + windows over SSH to `DERP_BUILD_HOST`, windows via `run-win-build.sh`) and publishes them.

---

## Gotchas (each cost real time)

- **gkrust OOM.** The `gkrust` LTO step needs ~17 GB for one rustc process. Linux: add a 32 GB
  swapfile (`fallocate`/`mkswap`/`swapon` on the build disk). Windows: the pagefile wouldn't grow,
  so `--disable-debug-symbols` is what actually fits it. It reads as `error: could not compile
  gkrust` / `LLVM ERROR: out of memory` but it is memory, not code. Shut down other VMs first.
- **`--enable-chrome-format=flat` is mandatory** — it's not in the base mozconfig; CI adds it via
  `setup-floorp.sh`. Without it the package ships `omni.ja` and derp's loose-file patcher can't apply.
  Verify by structure: `tar tf … | grep -c omni.ja` must be 0, BrowserGlue must be a loose `.mjs`.
- **A bare `mach build` skips the upstream patches.** The `.github/patches/upstream/*.patch` are
  applied by CI's setup step, not by `mach build`. Apply them (`git apply …`) or the L10n/branding/
  packaging fixes are silently absent.
- **Windows msiexec 1603** during `mach bootstrap` — run the build as an elevated scheduled task
  (RunLevel Highest), not a plain WinRM Win32_Process.
- **Windows `.exe.res` needs OS-specific icons.** Floorp's `browser/app/moz.build` overrides
  `DOCUMENT_ICO` to `branding/<dir>/content/{windows,mac,linux}/document.ico`. A branding dir copied
  from a stock Firefox branding lacks those subdirs → `llvm-rc: Error in ICON statement`. Windows-only.
- **`fetch_runtime` caches in `build/runtimes/`** and skips the download if the file already
  exists — so after re-publishing a runtime, `rm build/runtimes/floorp-<plat>-moz-artifact.*` or
  you'll package onto the old one. Verify the final package's `libxul`/`xul.dll`
  (`grep -c FirefoxFloorpMozilla` == 0), not just that packaging succeeded.
- **Stale-DMG-name trap.** `mach package`'s filename is `<app-name>-<ver>…`. When app-name changed
  floorp→derp the output became `derp-*.dmg`; the old `floorp-*.dmg` sat in `dist/` as a pre-fix
  artifact. Never hardcode the app-name in a copy step — `find dist -name '<appname>-*'`. Verify the
  runtime by content (`strings libxul|XUL | grep -c FirefoxFloorpMozilla` == 0), not by filename.
- **macOS SDK.** Gecko hard-requires SDK 26.4 (`toolkit.configure` `mac_sdk_min_version`). Point
  `--with-macos-sdk` at the local Xcode SDK; `mach bootstrap` 403s trying to download Apple's SDK.
- **`feles-build` renames the mac binary.** It keys off `BRANDING.base_name="floorp"`, so the
  installed binary is `Contents/MacOS/derp` (CFBundleExecutable=derp) but the bundle path is
  `_dist/bin/floorp/Floorp.app`. Launch `…/MacOS/derp` when driving by path; `open -a` is unaffected.
- **`override.sh` appends** to the already-modified `firefox.js` — deleting a pref line doesn't undo
  it; write the explicit opposite. The documented `@pref` lock syntax is not implemented.
- **Verify by a code-level marker, not a log line or a pref** (prefs can be Marionette automation
  hygiene). A build carries your change only if something it uniquely produces proves it.

---

## Quick reference

```bash
deno install                                   # deps
deno task feles-build stage --marionette       # dev: run derp locally (the only working launch path)
deno task dev-tool status                      # inspect a running instance over Marionette
tools/release/build-all-runtimes.sh <tag> all  # build+publish all 3 runtimes
tools/release/production-build.sh <tag> --skip-runtime all   # package + upload to your site
```
