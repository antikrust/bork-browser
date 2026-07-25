# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**bork** is a fork of Floorp 12 ("Noraneko"), a Firefox-based browser built on the Gecko
engine. This repo contains the feature layer that overlays Firefox — not the Firefox source
itself; the engine arrives as a prebuilt runtime (currently FF152, from bork-runtime).

Fork-specific: compact theme (`browser-features/skin/bork/`), Vivaldi-style workspaces and
tab stacks, zen mode, lean urlbar. Upstream remains `Floorp-Projects/Floorp` (`upstream`);
push to `origin` (`shithub.space/n01/bork`, self-hosted Forgejo — the project has moved
off GitHub). The compiled runtime is published as public Forgejo releases on
`shithub.space/n01/bork-runtime`, not GitHub. GitHub Actions are disabled on the fork —
do not re-enable.

**NO BRANCHES — commits go straight to `main` and are pushed to `origin main`.** Never
create a branch, never leave work stranded on one. If the session runs in a harness
worktree (which forces its own branch), fast-forward `main` to the commit and delete the
side branch — local and remote — before finishing. This overrides any default
branch-first guidance.

## Commands

```bash
deno install                        # Install dependencies
deno task feles-build stage         # THE working mode: build + launch (add --marionette to drive it)
deno task feles-build dev           # BROKEN on FF152 runtimes — see Build & Run below
deno task feles-build build         # Production build (two-phase: --phase before-mach / --phase after-mach)
deno task feles-build test          # Launch browser with Marionette for automated testing
deno task feles-build misc patch    # Manage Firefox source patches (apply/create/init)
deno task test                      # Run unit tests (browser-integrated, uses colocated test runner)
deno task test -- --near <path>     # Run tests near a specific file/directory
deno task test -- --layer chrome    # Run only chrome-layer tests (also: esm, pages, all)
deno task test:host                 # Run tool tests (Deno native)
deno task test:smoke                # Smoke tests
deno task dev-tool                  # Development utility CLI
```

## Build & Run (read this before editing anything)

`deno task feles-build stage --marionette` is the only working launch path. **Dev/HMR mode is
broken on FF152**: the loader is fetched over privileged HTTP, which the runtime now blocks
natively, so `feles-build dev` never boots the feature layer.

**Every code change needs a full stage cycle.** Stage serves the chrome layer from vite dev
servers, but the served code is pinned at server start — relaunching the browser against
already-running servers gets you the code as of the last stage run, not what is on disk.
There is no shortcut; `_dist/noraneko/content/core.js` is stale fallback output, not what runs.

```bash
deno task dev-tool stop                       # ends browser AND the vite servers
pkill -f feles-build                          # stray build trees
for p in $(lsof -ti tcp:5170-5190); do kill $p; done   # see below
rm -f _dist/marionette-port.txt
deno task feles-build stage --marionette >> /tmp/bork-launch.log 2>&1 &
# ready when _dist/marionette-port.txt exists AND the floorp process is up
```

Gotchas that cost real time:

- **Stale vite servers fail the next run.** A leftover server holding 5181 makes the new stage
  die with `main (port 5181) exited early with code 1` (details in `logs/vite-main.log`).
  Sweep 5170–5190 first — but *only* when no browser is attached to them: those servers are
  the running feature layer, not garbage.
- **`_dist/marionette-port.txt`** is written by the launcher and **deleted when the browser
  exits** — an exiting old launcher racing a new one leaves dev-tool unable to connect.
  Recreate with `echo 2828 > _dist/marionette-port.txt` (Marionette's default port).
- **`deno check` fails even on untouched upstream files.** Vite/the build is the authority.
  Type-check single files if useful, don't trust a clean tree.
- Anchor process greps: `pgrep -f "^/Users/blah/github/bork/_dist/bin/floorp"` — an unanchored
  `-f` match also hits your own wrapper shells.
- **Verify the running code by a code-level marker**, not by prefs or boot log lines. A pref
  says what the profile holds; only something the new code uniquely produces proves the build
  carrying it is what you are looking at.
- **Marionette rewrites prefs.** Launching with `--marionette` applies the remote agent's
  RecommendedPreferences as user prefs — safe-browsing off, updates off, and dozens more.
  A "wrong" pref read from the dev browser may be automation hygiene, not your config:
  check `prefHasUserValue` and whether the name appears anywhere in the tree before chasing it.
- **Hover/timer tests need one eval.** Each Marionette eval is an interaction (popups
  auto-hide, hover retargets). Verify time-dependent UI inside a single eval with
  `Services.tm.spinEventLoopUntil(...)`, not across two connections.

## Architecture (5 Layers)

```notes
Firefox Base  ← patched Gecko, pref overrides (static/gecko/pref/override.ini)
     ↓
ESM Modules   ← .sys.mts files with direct Firefox API access, Window Actors
     ↓
Bridge        ← startup scripts that load features from Vite dev servers (HTTP) or chrome://noraneko/ (prod)
     ↓
Chrome UI     ← SolidJS → XUL via custom solid-xul renderer, auto-discovered by import.meta.glob
     ↓
Pages         ← React + Tailwind full-page UIs (settings, new tab, welcome, notes, etc.)
```

The bridge (`bridge/startup/src/chrome_root.ts`) is the bootstrap: in dev/test mode it loads from `http://localhost:5181/loader/index.ts` with retry logic; in production it loads `chrome://noraneko/content/core.js`.

## Tech Stack

- **Runtime**: Deno 2.x (primary), Node.js 22 (some pages)
- **Browser Chrome UI**: SolidJS + `@nora/solid-xul` (custom renderer that uses `document.createXULElement()` via `solid-js/universal`'s `createRenderer`)
- **Settings/Pages UI**: React + Tailwind CSS
- **Build**: Vite via custom `feles-build` system (`tools/feles-build.ts`)
- **Language**: TypeScript (strict)

## Path Aliases (deno.json)

```typescript
#i18n/              → ./i18n/
#chrome/            → ./chrome/
#libs/              → ./libs/
#features-chrome/   → ./browser-features/chrome/
#modules/           → ./browser-features/modules/
#ui/                → ./src/ui/
#themes/            → ./src/themes/
```

## Coding Conventions

### File Placement

| What               | Where                                                         | Framework   |
| ------------------ | ------------------------------------------------------------- | ----------- |
| Browser UI feature | `browser-features/chrome/common/{name}/`                      | SolidJS     |
| Firefox API module | `browser-features/modules/modules/{name}.sys.mts`             | Firefox ESM |
| Settings page      | `browser-features/pages-settings/src/app/{name}/`             | React       |
| Actor (IPC)        | `browser-features/modules/actors/{Name}Parent\|Child.sys.mts` | Firefox ESM |

### Feature Auto-Discovery

`browser-features/chrome/common/mod.ts` uses `import.meta.glob("./*/index.ts")` — adding a directory with an `index.ts` under `common/` is sufficient. No manual registration needed.

Actor registration is manual: add entries to the `JS_WINDOW_ACTORS` object in `browser-features/modules/modules/BrowserGlue.sys.mts`.

### Type Definitions

Separate types into dedicated `types.ts` files. Exception: `.sys.mts` files may include inline types.

### No `any`

Never use `any`. Use explicit types or `unknown`.

### SolidJS Pattern (Browser Chrome)

```typescript
import { noraComponent, NoraComponentBase } from "#features-chrome/utils/base";
import { render } from "@nora/solid-xul";
import { createSignal } from "solid-js";

@noraComponent(import.meta.hot)
export default class MyFeature extends NoraComponentBase {
  init(): void {
    /* ... */
  }
}
```

- Always use the `@noraComponent(import.meta.hot)` decorator — it registers the component with
  the loader. (Its HMR half is inert on FF152, but the registration is what mounts your feature.)
- Use `createSignal` / `createMemo` for reactive state — never mutate variables directly

### Firefox ESM Modules (.sys.mts)

```typescript
const { SomeService } = ChromeUtils.importESModule(
  "resource://floorp/lib/SomeService.sys.mjs",
);
```

### React Pattern (Settings Pages)

```typescript
export default function MyPage() {
  const [value, setValue] = useState("");
  return <div className="p-4">...</div>;
}
```

### i18n

Translations use i18next-style `{{variable}}` interpolation and `_plural` suffix keys. Add strings to at least `i18n/en-US/` and `i18n/ja-JP/`. Organized by feature namespace in `browser-chrome.json`.

### Error Handling

Use try/catch with `console.error("[FeatureName]", ...)` prefix for log messages.

## Testing

Tests run **inside the actual Firefox browser**, not in Deno/Node. They are plain TypeScript functions with a custom harness (`test_harness.ts` providing `assert`, `assertEquals`, `TestCase`), not `Deno.test()`.

```typescript
// @colocated-env browser
import { type TestCase, assert } from "../../../test/utils/test_harness.ts";

function testSomething(): void {
  assert(condition, "message");
}

export function runAllTests(): void {
  const tests: TestCase[] = [{ name: "something works", fn: testSomething }];
  // ...run and collect failures
}
```

Colocated in `test/` directories next to source. The runner discovers them automatically.

## Dev Server Ports

These are the running feature layer in stage mode, not build leftovers — the browser fetches
chrome features from them live.

- 5173: Main features
- 5174–5177: Other pages
- 5178: Settings pages
- 5181: Feature loader (bridge) — the browser's entry point; if this is dead, no chrome features load
- 5186: New tab page

## dev-tool — Browser Inspection CLI

`deno task dev-tool` communicates with a running instance via the **Marionette protocol**
(Firefox's TCP-based WebDriver). Browser commands need the browser running **and launched with
`--marionette`** (`feles-build stage --marionette`). `dev-tool start` uses the broken dev path
on FF152 — use stage instead.

`eval` wraps its argument in parentheses: pass a **single expression**. Statements
(`var x = 1; ...`) are a syntax error; use an IIFE — `(function () { ... })()` — and
`JSON.stringify` the result.

### Process Management

```bash
deno task dev-tool start      # Start dev server + browser in background (waits for Marionette ready)
deno task dev-tool stop       # Kill all dev processes (deno, vite, floorp) cleanly
deno task dev-tool restart    # Stop then start
deno task dev-tool rebuild    # Rebuild startup + modules + inject XHTML without restarting browser (HMR handles loader-features)
```

### Browser Commands

```bash
deno task dev-tool status                                      # Check connection: shows page title, URL, tab count, active tab
deno task dev-tool eval "JSON.stringify(Services.prefs.getStringPref('floorp.some.pref'))"  # Execute JS in browser (returns result)
deno task dev-tool console                                     # Last 50 console messages (via Services.console)
deno task dev-tool console -l 100 -f "workspace" -l error      # Filtered: 100 messages, text filter "workspace", errors only
deno task dev-tool console --level error                       # Level filter: error/warn/info/debug/all
deno task dev-tool screenshot                                  # Full-page screenshot → _dist/screenshot.png
deno task dev-tool screenshot -s "#tabbrowser-tabs" -o out.png # Element screenshot by CSS selector
deno task dev-tool navigate about:preferences                  # Navigate browser to URL
deno task dev-tool dom "#sidebar-box"                          # Inspect DOM: tag, id, class, text, attributes, child count
deno task dev-tool title                                       # Get current page title
```

### Context Flag (`--context` / `-c`)

All browser commands accept `--context` to choose the JS execution context:

- `chrome` (default) — browser chrome scope. Access `Services`, `gBrowser`, XUL elements, Firefox internals, prefs
- `content` — web content scope. Interact with loaded page DOM as a normal web page

```bash
deno task dev-tool eval "gBrowser.tabs.length" -c chrome    # Count open tabs (chrome context)
deno task dev-tool eval "document.title" -c content         # Get page title from content context
```

### Typical LLM Workflow

1. Edit source files
2. Full stage cycle (see **Build & Run**) — there is no hot path; every change needs one
3. `deno task dev-tool console --level error` — check for runtime errors
4. `deno task dev-tool eval "..."` — inspect live state (prefs, DOM, services), and prove the
   build actually carries your change
5. `deno task dev-tool screenshot [-s "#selector"]` — visually verify
6. `deno task dev-tool stop` — shut down when done (ends the vite servers too)

## Chrome-layer landmines (each of these cost hours)

**Prefs / `override.ini`**
- The documented `@pref = value` **lock syntax is not implemented** by any tooling — a locked
  pref silently does nothing at all (the name never matches).
- `override.sh` **appends onto the already-modified `firefox.js`**, so prefs accumulate: deleting
  a line from `override.ini` does *not* undo it. Write the explicit opposite value instead.

**Firefox chrome (FF152)**
- `.toolbarbutton-icon` **is** the image element, not a container around it —
  sizing it scales the glyph. Put fills/hovers on the button instead.
- `#urlbar-container` defines `--urlbar-container-height` **on itself** (a calc
  from the urlbar's height + padding), so a `:root` value never reaches it; an
  element's own custom-property definition beats anything inherited. Its
  `min-height` is what sets the nav bar's height — every toolbar button
  stretches to match.
- `SessionStore.persistTabAttribute` **no longer exists** (and `TabAttributes.sys.mjs`
  hard-codes its list to `["customizemode"]`, so nothing can register a new name).
  Feature-detect before calling it. **Do not "fix" this by porting to
  `setCustomTabValue`** — tab attributes that need to survive a restart are carried by the
  Noraneko runtime patches, not by SessionStore's attribute machinery:
  `tools/patches/browser-modules-sessionstore-TabState.sys.patch` writes them onto `tabData`
  on collect (`floorpWorkspaceId`, `floorpWorkspaceLastShowId`, `floorp-disablehistory`,
  `floorpSplitViewGroupId`) and the tabbrowser patch sets them back on restore. A new
  attribute needing persistence belongs in **that pair**. `setCustomTabValue` is a second,
  independent route — split-view's session-restore code uses it as a fallback — but adding it
  where the patches already carry the attribute just gives you two sources of truth.
- `tab-group` is **`display: contents`** — it has no box. Sizing rules on it do nothing; its
  children participate directly in the strip's flexbox. Style `.tab-group-label-container`.
- `visibility: collapse` **only removes width in XUL box layout**. The tab strip is flexbox,
  where collapsed tabs still claim their flex size. Zero every box metric to hide a tab.
- **Lazy tabs have `linkedPanel === null`** (background-created and session-restored tabs).
  Anything reading it must tolerate null.
- macOS panels animate open via **native window transforms**; repositioning or fading a panel
  mid-animation raced that machinery and left windows composited as an empty frame (the
  "vanishing window" hunt). `widget.macos.window-transforms.disabled = true` switches it off —
  do not remove without re-testing. Position panels on `popupshowing`, before first paint.

**XUL layout attributes beat CSS — always**
- `pack`, `align`, `flex`, `orient` on XUL boxes are mapped by Gecko as
  *presentation hints*. Author CSS cannot override them at any specificity —
  not `!important`, not an inline style. `pack="center"` on the tab-group label
  container centred stack chips 1px low and no CSS could move them; setting
  `pack="start"` on the element fixed it instantly.
- **The diagnostic**: if an inline `!important` does not change the computed
  value, stop escalating specificity — look for a XUL attribute.

**The design layer fights the theme**
- It re-sets `--tab-min-height` (32px) with equal-importance rules that win by load order.
  Anything needing the compact height must read **`--bork-tab-height`** (theme-owned,
  `skin/bork/css/bork.css`) instead. It also inflates the tab close button and sizes strip and
  tab paint boxes to 32px.
- When a rule refuses to apply, check for a stronger cascade origin before escalating
  specificity: `display` on the tab close button could not be beaten, but `opacity` was
  untouched — and made a better crossfade anyway.

**`@nora/solid-xul`**
- `setProperty` throws on unknown value types. `null` and `undefined` now both clear the
  attribute, but a `null` prop used to take down the entire component render (one lazy tab's
  null `linkedPanel` blanked the whole stack bar). Coerce values into the renderer.
- **No `ref={var}`** — the renderer doesn't export the `use` directive the Solid compiler
  emits for refs (`"use" is not exported by solid-xul`, build fails). Grab elements with
  `onMount(() => document.getElementById(...))` instead.
**Every horizontal `<arrowscrollbox>` needs the wheel guard, not just the strip**
- The momentum snap-back (`scrollback-error.md`) is stock toolkit behavior, so it applies to
  **any** horizontal arrowscrollbox. The 2026-07-17 fix was scoped to `#tabbrowser-tabs`, which
  left the stack bar (row 2, the same widget) snapping back — and row 2's `on_wheel` swallows the
  event (`preventDefault` + `stopPropagation`) whenever it is `[overflowing]` **even when its
  axis filter refuses to scroll**, so the page loses those wheels too. The rules now live in
  `tab-strip-wheel-guard/attach.ts` and are attached to both boxes, sharing one
  `globalThis.__borkWheelGuard` readout. **Any new arrowscrollbox must call `attachWheelGuard`.**

**`<arrowscrollbox>` click-to-scroll leaks a per-frame loop — page scroll freezes**
- Holding a scroll arrow starts a loop (repeating timer for line scroll, an rAF chain for
  smooth) and **`_arrowScrollAnim.sample()` re-requests a frame unconditionally**: the only exit
  is an explicit `_stopScroll()`. Stock calls that from `on_mouseup`/`on_mouseout`, which **bail
  out unless `event.originalTarget` IS an arrow button** — so it is lost whenever:
  - the **left arrow disables itself** (`"#scrollbutton-up": "disabled=scrolledtostart"`) as the
    box reaches its start: a disabled XUL button dispatches no mouse events, so the release is
    never seen and stock has **no recovery path at all**; or
  - the box **unmounts mid-press** (`<Show>`/`<For>`) — its own guard is `if (!document)`, never
    true for a detached node (`document` is the global, not the element's).
- The loop then calls `scrollBy` every frame forever (measured ~60/s, scrolling against a wall).
  That parent-process work starves the main thread remote-content wheel input needs, so **the
  page stops scrolling and only flushes with a visible jerk** when something else stops the loop
  — this is the "scroll on row 2 then the page won't scroll" bug, and typing appeared to fix it.
- Both bork arrowscrollboxes therefore run a release watchdog (document-capture
  `mouseup`/`pointercancel`/`blur` → `_stopScroll()` + cancel timer/anim, plus on unmount):
  `tab-stacks/stack-bar.tsx` and `tab-strip-wheel-guard/index.ts`. **Do not remove**; holding an
  arrow still scrolls because `_stopScroll()` is exactly what stock runs on a normal release.

**Zen mode**
- Retracts by **self-sizing transforms** (`translateY(±100%)`) with the toolbox/statusbar out of
  flow — deliberately no measured distances, because cached measurements went stale on every
  chrome change (address-bar toggle, stack bar mount) and either cut off the page top or left a
  blank strip. Only the panel sidebar still measures (its two boxes share one edge); a
  ResizeObserver trues those up and `[zenmode-rebase]` makes the correction snap, not slide.
  **Do not reintroduce measured heights here.**

## Debugging

- Browser Console: `Ctrl+Shift+J` / `Cmd+Option+J`
- DevTools: `Ctrl+Shift+I` / `Cmd+Option+I`
- Log convention: `console.log("[FeatureName]", ...)`

## Further Reading

`docs/development/` holds upstream's docs. (The `docs/llm/` overview, architecture and
development-notes files this section used to list do not exist in this tree.)
