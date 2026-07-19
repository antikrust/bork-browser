# derp / Floorp 12 — Architecture Audit

**Date:** 2026-07-19 · **Scope:** how this repo is structured, how it builds, how it survives
Firefox releases, and what leaving Floorp would cost.

Everything below was verified against the tree at `a28a96d69d`. Where I'm inferring rather
than reporting, it says so.

---

## 1. What this repo actually is

Two repos, split by build cost:

| Repo | Contents | Who builds it |
| --- | --- | --- |
| `Floorp-Projects/Floorp-runtime` | Patched mozilla-central (Gecko) | CI, artifact builds |
| **this repo** | The feature layer that overlays it | you, in seconds |

This repo contains **no Gecko source**. It produces a set of JS/CSS/HTML bundles plus a chrome
manifest, and glues them onto a prebuilt runtime binary.

Size of the thing you inherit:

```
browser-features/   196,346 lines   ← Floorp's actual feature layer
libs/@types/         81,290 lines   ← generated Gecko type defs (not hand-written)
tools/               14,348 lines   ← build system + an LLM docs pipeline
bridge/               2,221 lines   ← the bootstrap
static/               1,442 lines   ← pref overrides, installers
```

Your fork is **80 commits** ahead of `upstream/main`.

---

## 2. How the build works

### 2.1 The runtime arrives prebuilt

`tools/src/initializer.ts:20`

```ts
const RUNTIME_BASE_URL = "https://dev-assets.floorp.app/floorp-runtime-builds/";
```

It downloads a platform archive (`.dmg` / `.tar.xz` / nested `.zip`), unpacks it to `_dist/bin`,
and stamps `_dist/bin/nora.version.txt`.

**There is no Firefox version pin anywhere in this repo.** The `VERSION` constant that gates
re-extraction is a cache-buster, not a Gecko version:

```ts
// tools/src/defines.ts:33
export const VERSION = ["windows", "linux"].includes(PLATFORM) ? "002" : "000";
```

`static/gecko/config/version.txt` says `version: 1.0.0` — also not a Firefox version. The only
place "FF152" is recorded in this tree is prose in `CLAUDE.md`. See §7.2.

Local cache (macOS conspicuously absent):

```
build/runtimes/floorp-linux-x86_64-moz-artifact.tar.xz    78M
build/runtimes/floorp-windows-x86_64-moz-artifact.zip    125M
```

### 2.2 Patching — 13 patches, 696 lines total

`tools/patches/`, applied by `tools/src/patcher.ts` onto the **unpacked runtime's loose JS
files** (artifact builds ship chrome JS unpacked, so no `omni.ja` repacking is needed). Applied
copies land in `_dist/bin/applied_patches/`.

```
197  moz-src-toolkit-components-search-SearchService.sys.patch
103  browser-chrome-...-tabbrowser-tabbrowser.patch
 75  browser-chrome-...-tabbrowser-content-area.patch
 71  derp-branding.patch
 65  browser-chrome-...-browser-init.patch
 51  browser-modules-MigrationUtils.sys.patch
 29  browser-modules-sessionstore-TabState.sys.patch
 28  browser-modules-CustomizableUI.sys.patch
 19  browser-modules-BrowserGlue.sys.patch          ← the load-bearing one
 19  modules-NativeManifests.sys.patch
 15  browser-modules-UrlbarController.sys.patch
 13  modules-ResetProfile.sys.patch
 11  browser-chrome-...-aboutDialog.patch
```

**696 lines is the headline number of this audit.** For comparison, browser forks that vendor
mozilla-central carry six-figure diffs. Floorp's entire hook into Firefox startup is this:

```js
/*@ NORA INJECT START @*/
try {
  ChromeUtils.importESModule("resource://noraneko/modules/NoranekoStartup.sys.mjs");
} catch (e) { ... }
```

One import in `BrowserGlue.sys.mjs`. Everything else loads from there.

### 2.3 Registration — a chrome manifest, not a rebuild

`tools/src/injector.ts:134-163` writes a `noraneko.manifest`:

```
content  noraneko              content/    contentaccessible=yes
content  noraneko-startup      startup/    contentaccessible=yes
content  noraneko-skin         skin/       contentaccessible=yes
content  noraneko-help         help/       contentaccessible=yes
resource noraneko              resource/   contentaccessible=yes
content  noraneko-pages-aboutdialog pages-aboutDialog/ contentaccessible=yes
override chrome://browser/content/aboutDialog.xhtml \
         chrome://noraneko-pages-aboutdialog/content/aboutDialog.html
```

…appends `manifest noraneko-devdir/noraneko.manifest` to the runtime's own `chrome.manifest`,
and symlinks the built dirs into the binary dir. `tools/scripts/xhtml.ts` patches `browser.xhtml`
to add the script tags.

Note that single `override` line — Floorp **does** know how to replace a stock Firefox page
wholesale. It uses that power exactly once, for the About dialog. Remember this for §5.

### 2.4 The four modes

| Mode | What it does |
| --- | --- |
| `dev` | Serves chrome from vite over HTTP. **Broken on FF152** — privileged HTTP fetch is now blocked. |
| `stage` | Production assets, dev-style dir layout. The only working local path. |
| `build --phase before-mach` / `after-mach` | For CI *inside* a mozilla-central tree. The root `moz.build` lists `_dist/noraneko/*` as `DIRS`, so mach picks the output up as if it were part of the browser. |
| `test` | stage + Marionette. |

### 2.5 CI

`.github/workflows/package.yml` checks out `${{ github.repository }}-runtime`, runs
`mach bootstrap --application-choice browser_artifact_mode` with `ac_add_options
--enable-artifact-builds`, and pulls `dmg.tar.zst` / `hfsplus.tar.zst` straight from Mozilla's
taskcluster. **Artifact builds mean Gecko is never compiled** — Mozilla's prebuilt C++ is
downloaded and only the JS/chrome layer is built. This is the economic key to the whole design,
and to §6.

(Actions are disabled on this fork; packaging happens locally via `tools/release/`.)

---

## 3. What happens when a new Firefox ships

**The mechanical path:** the runtime repo rebases onto the new mozilla-central, CI publishes new
artifacts, this repo downloads them. For the feature layer, a Firefox release is a *download*.

**Where it actually breaks** — and it is not the patches:

| Surface | Size | Failure mode |
| --- | --- | --- |
| 13 runtime patches | 696 lines | **Loud.** Context diffs fail to apply; you find out immediately. |
| Direct Firefox API calls | ~1,800 call sites | **Loud-ish.** Throws at runtime, lands in the console. |
| CSS keyed to Firefox's internal DOM | ~39,400 lines | **Silent.** A renamed id doesn't error — the rule just stops matching, and the UI is subtly wrong. |

Measured touchpoints (source only, excluding `_dist` and Lepton):

```
Services.*        927
gBrowser          695
SessionStore       89
resource://gre     89
CustomizableUI     85
resource:///modules 14
```

**There is no compat or abstraction layer.** Features call Firefox internals directly,
everywhere. What exists instead is institutional memory — the "Chrome-layer landmines" section
of `CLAUDE.md`, which is a hand-maintained list of exactly the things that broke before
(`SessionStore.persistTabAttribute` gone, `tab-group` being `display: contents`,
`visibility: collapse` not working in flexbox, XUL presentation-hint attributes beating CSS at
any specificity). That list is doing the job an abstraction layer would do, in prose, at the
cost of being unenforced.

The largest single liability is **Lepton** (`browser-features/skin/lepton/`, 39,023 lines of
CSS), a vendored third-party Firefox theme, auto-updated by `update_lepton.yml`. It is keyed to
Firefox's internal DOM across its whole surface, it is not yours, and per `CLAUDE.md` it
actively fights your theme ("The design layer fights the theme" — it re-sets `--tab-min-height`
and wins on load order, forcing your CSS to read `--derp-tab-height` instead). Your own theme is
**403 lines**.

---

## 4. Is this a good way to add customisation?

Mixed, and the good parts are genuinely good.

### What's right

- **The thin-patch + manifest-overlay design is excellent.** 696 patch lines and a single
  startup import is about as little coupling as a browser fork can get away with. It is the
  reason a Firefox bump is a download rather than a merge war.
- **Actor-based privilege bridging** (`NRSettingsParent` et al.) is the correct Firefox-native
  pattern, not a hack.
- **Feature auto-discovery** via `import.meta.glob("./*/index.ts")` — a directory is a feature.
  Clean.
- **`tab-strip-wheel-guard` is the model of how this should work.** Your own writeup
  (`floorp-issue.md`) diagnoses a three-mechanism bug in *stock* toolkit/browser code and fixes
  it entirely in the feature layer, pref-gated, with zero runtime patches. That is the
  architecture paying off.

### What's questionable

- **SolidJS → XUL via a custom renderer** (`libs/solid-xul`, 454 lines). A reactive renderer
  bolted onto XUL is a large bet for modest gain, and it already has sharp edges you've hit:
  `setProperty` throws on unknown value types, and one lazy tab's `null` `linkedPanel` blanked
  an entire component render.
- **Three UI idioms in one browser**: SolidJS (chrome), React + Tailwind (pages), and stock
  Firefox XUL/HTML. Every contributor learns all three.
- **~1,800 unguarded internal touchpoints** with no shim. Even a 200-line compat module over the
  top five APIs would convert silent breakage into one file to fix.
- **Tooling weight**: 14k lines in `tools/`, including a full LLM-driven docs pipeline
  (`tools/docs-pipeline/`, ~2k lines of generator alone) for a project whose docs are elsewhere.
- **Lepton**, as above.

---

## 5. Why there are two settings pages

This is the part you asked about directly, so here are the verified facts before the opinion.

### What is actually true

1. **`about:preferences` is not replaced, redirected, or patched.** No patch in `tools/patches/`
   touches it. It is fully present and functional.
2. **Floorp's settings UI is a separate React SPA** at
   `chrome://noraneko-settings/content/index.html`, surfaced as **`about:hub`**. It is
   registered *at runtime*, not in the manifest — `NoranekoStartup.sys.mts:326` builds a custom
   about-page map (the code is credited to Geckium's `aboutPageRegisterer`):

   ```ts
   const customAboutPages: Record<string, string> = {
     hub: "chrome://noraneko-settings/content/index.html",
     welcome: "chrome://noraneko-welcome/content/index.html",
   };
   ```

3. **Size**: 87 files, ~11,126 lines, 12 route groups — `about`, `accounts`, `dashboard`,
   `design`, `floorp-os`, `gesture`, `keyboard-shortcut`, `pwa`, `search`, `sidebar`, `updates`,
   `workspaces`.
4. **Prefs reach Gecko through a generic RPC**, not through Firefox's preferences framework.
   `NRSettingsParent.sys.mts` is a thin `get/setBoolPref | IntPref | StringPref` proxy with no
   allowlist — the content page can read or write **any** pref by name.
5. **The two are bridged by a nag banner.** `NRAboutPreferencesChild` injects
   `bridge/startup/src/about-preferences.ts` into `about:preferences` on `DOMContentLoaded`,
   which renders a `floorp-hub-warning` box with a button that opens the Hub.
6. Lepton additionally themes `about:preferences` (~10 `@-moz-document
   url-prefix("about:preferences")` blocks), so Floorp is *styling* the page it is
   simultaneously telling you not to use.

### Why they did it

The honest reasons, in order of weight:

1. **`about:preferences` is welded to the runtime.** It's XUL-ish, uses `<preference>` elements
   and the `Preferences.addSyncFromPrefListener` machinery, its strings are Fluent `.ftl` files
   shipped *inside the runtime*, and it has its own subdialog framework. Extending it means
   patching runtime files that churn every single Firefox release — precisely what the 696-line
   architecture exists to avoid. **The two settings pages are a direct consequence of the
   thin-patch strategy.** It's not carelessness; it's the bill for the thing that makes this
   fork cheap.
2. **Their features have no home in Firefox's information architecture.** Workspaces, panel
   sidebar, PWA, mouse gestures, keyboard shortcuts, floorp-os — none of these map onto
   Firefox's pane structure.
3. **Velocity.** React + Tailwind + Vite iterates far faster than XUL preference panes.
4. **i18n.** Crowdin-managed JSON in `i18n/`, not Fluent.

### Why it's still bad

Two front doors, two search boxes, no cross-search, and a *nag banner* as the bridge. A user
looking for a setting has to know which browser it belongs to. You like the look of theirs —
correctly, it's the better UI — which makes the split worse, not better: the good page is the
one that doesn't own most of the settings.

### The option they didn't take

They already own the mechanism. One extra line in `injector.ts`:

```
override chrome://browser/content/preferences/preferences.xhtml <your page>
```

…is exactly what they already do for `aboutDialog`. Host the React app there and you have one
front door.

**The cost is real and I won't undersell it:** you then own the entire preferences surface,
forever, including every stock Firefox pref (privacy, sync, search engines, containers,
certificates, the whole subdialog tree). You'd either reimplement those panes or proxy them, and
proxying XUL subdialogs into a React shell is genuinely unpleasant. That's a multi-week
commitment, not an afternoon.

**My recommendation for derp:** don't attempt full replacement yet. Do the cheap 80% —
kill the nag banner, make `about:hub` the unambiguous home for *derp* features only, and add
one clearly-labelled link each way. Revisit replacement only if the settings surface becomes a
differentiator you care about.

---

## 6. Moving off Floorp — three options, honestly costed

### Option A — Stay on the feature layer, diverge in-tree *(current path)*

What you're already doing across 80 commits.

- **Cost:** low. Upstream merges stay possible.
- **Risk:** you depend on `dev-assets.floorp.app` staying up and on Floorp continuing to publish
  runtimes for your platform. That is a **single point of failure you do not control**, and
  macOS isn't even in your local cache.

### Option B — Fork the runtime too *(recommended)*

Fork `Floorp-runtime` (or `nyanrus/noraneko-runtime`) and run your own artifact builds.

> **CORRECTION (2026-07-19, after inspecting the runtime repo).** An earlier draft of this
> section claimed forking the runtime "does not entail compiling Gecko." **That was wrong**, and
> it understated the cost materially. The error was conflating two different uses of the word
> "artifact":
>
> - **This repo's CI** (`package.yml`) uses `--enable-artifact-builds` — it *consumes* prebuilt
>   binaries and compiles no C++. That part of §2.5 stands.
> - **The runtime repo** *produces* those binaries. Its mozconfigs
>   (`.github/workflows/mozconfigs/*.mozconfig`) contain **no** `--enable-artifact-builds`.
>   They are full Gecko compiles — `--enable-bootstrap`, `--enable-rust-simd`,
>   `AUTOCLOBBER=1` — with separate PGO profile-generation workflows
>   (`generate-pgo-profile-linux.yml`, `mac_pgo.yml`).
>
> Forking the runtime means **you compile Firefox**. Corrected costs below.

- **What it entails:** a mozilla-central checkout (the repo is ~1.9 GB), `mach bootstrap`, a
  full C++ toolchain, and real build hardware. CI is repointed from `${repo}-runtime` to yours.
- **Build cost per platform:** roughly 1–2 h for a clean non-PGO build on a fast 16-core machine;
  PGO roughly triples that (instrumented build → profile run → optimised build). Budget 30–40 GB
  of objdir *per target*, and 32 GB RAM to link comfortably.
- **PGO is the big lever.** Dropping it cuts build time ~3× at some runtime-performance cost.
  Start without it.
- **Cross-compilation is the good news.** `common-build.yml` runs on `ubuntu-latest` and builds
  Linux, Windows (`--target=x86_64-pc-windows-msvc`) and macOS targets from that one Linux host.
  The only step needing a real Mac is a **one-time macOS SDK extraction** from Xcode
  (`wrapper-mac-build.yml` does this on `macos-26`, tars the SDK, and hands it to the Linux
  builder). So a single adequate Linux box can produce all three desktop platforms.
- **Effort:** ~1–2 weeks to a reliable self-hosted pipeline, not days. Then a rebase cost per
  Firefox release.
- **Payoff:** removes your worst dependency, and hands you the **compiled branding tier** —
  these live in the mozconfigs and are currently unreachable from the feature layer, which is
  why `derp-branding.patch` exists:

  ```
  ac_add_options --with-app-name=floorp
  ac_add_options --with-app-basename=Floorp
  ac_add_options --with-distribution-id=app.floorp
  ac_add_options --with-branding=browser/branding/noraneko-unofficial
  ```

  After the fork, renaming the browser is editing those four lines instead of patching
  runtime resources.

### Option C — New feature layer against stock Firefox

The bootstrap mechanism is generic and small: patch `BrowserGlue` to import one module, register
a chrome manifest, inject script tags into `browser.xhtml`. That's maybe 50 of the 696 patch
lines. You could rebuild it in a weekend and drop all 196k lines.

Then you re-earn every feature: split-view (8,405), mouse-gesture (8,280), workspaces (7,533),
command-palette (6,848), designs (5,581), panel-sidebar (5,426)…

- **Verdict:** only rational if you want *very* few features. Given workspaces and tab-stacks are
  central to derp, this means rewriting the two hardest things in the tree. **Not recommended.**

### Recommended: B + prune, not C

Take Option B for supply-chain independence, then **delete rather than rewrite**. derp is a
compact-theme / workspaces / tab-stacks / zen-mode browser. Candidates you plausibly don't ship:

| Candidate | LOC | Note |
| --- | --- | --- |
| `skin/lepton` | 39,023 | Biggest win. Not yours, fights your theme, highest per-release liability. |
| `pwa` | 4,615 | + `libs/pwa`, `NRPwaManager*`, `NRProgressiveWebApp*` |
| `floorp-os` / `os-server` | — | Pulls the `Floorp-Sapphillon-Plugins` git submodule |
| `chrome-web-store`, `webscraper`, `experiments`, plugin store | — | Actor pairs + modules |

Deleting cuts the coupling surface proportionally — every removed feature is removed `gBrowser`
calls you never have to fix again. It is strictly cheaper than rewriting.

---

## 7. Concrete recommendations, ordered

1. **Mirror the runtime.** `dev-assets.floorp.app` is an uncontrolled dependency and the macOS
   artifact isn't cached locally. Do this before anything else in §6.
2. **Record the Firefox version in-tree.** Nothing in this repo states FF152 except prose in
   `CLAUDE.md`; `VERSION` is a cache-buster and `version.txt` says `1.0.0`. A stamped
   `runtime.lock` costs nothing and makes "what broke?" answerable.
3. **Decide on Lepton.** Keep or delete, but do it knowingly — it's 39k lines of someone else's
   Firefox-DOM-coupled CSS auto-updating into your tree.
4. **Settings: one front door.** Kill the nag banner; scope `about:hub` to derp features. Defer
   full `about:preferences` replacement.
5. **Add a compat shim** over the top five Firefox internals. ~200 lines converts a class of
   silent, distributed breakage into one file.
6. **Tighten `NRSettingsParent`.** It currently proxies arbitrary pref reads and writes from
   content by name, with no allowlist. Given the actor also matches `*://localhost/*`, that
   deserves a second look.

---

## 8. Confidence and gaps

- **Verified directly:** patch inventory and sizes, runtime download URL and unpack path,
  manifest/injection mechanism, the BrowserGlue hook, `about:hub` registration, the
  `about:preferences` non-replacement and the nag-banner bridge, `NRSettingsParent`'s API
  surface, all LOC counts, touchpoint counts, CI artifact-build flow.
- **Corrected after publication:** §6 Option B originally stated that forking the runtime would
  not require compiling Gecko. It does. See the correction box in that section — the estimate
  moved from "days" to "1–2 weeks", and the hardware requirement is real.
- **Verified in the runtime repo (2026-07-19):** `Floorp-Runtime` is ~1.9 GB, default branch
  `nora-0.2.0`, actively pushed. Firefox releases are absorbed as `sync/nora-0.2.0/upstream-<ver>`
  branches — the series runs 143.0.5 → 153.0, so **FF153 exists upstream while this tree is on
  152**. Daily releases (`daily-985` and counting) publish per-platform artifacts including the
  macOS `.dmg` that is missing from `build/runtimes/`.
- **Not verified:** Floorp's
  own reasoning for the settings split (inferred from the code and constraints, not from any
  statement by the maintainers); the effort estimates in §6, which are judgement calls.
- **Tooling note:** `grep` in this environment is shimmed to `ugrep --ignore-files`, which
  honours `.gitignore` and returned inconsistent results across multi-path invocations. All
  counts above were produced with `command grep` to bypass the shim.
