# Zen mode, chrome toggles, and the dev cycle

Written up 2026-07-23, after a run of fixes where most of the time went not
into the bugs but into measuring the wrong thing. Everything here is
recorded because it produced a *silent* wrong answer — no error, no log
line, just a result that looked real and was not.

## 1. `#browser` is a single flex row

The workspaces rail, Firefox's own sidebar, the panel-sidebar cluster and
the content are all siblings in one flex row, with CSS `order` putting the
panel cluster at the right edge:

```
sidebar-main │ sidebar-box │ panel-sidebar-box │ splitter │ panel-sidebar-select-box │ tabbrowser-tabbox
```

**Any zen retract that changes a sibling's width or margin reflows the
content area on every frame it animates.** This is a property of the
mechanism, not of the easing. Three separate attempts were made to fix the
resulting sideways drift by moving the `transition:` declaration to a
different stylesheet; none of them could have worked, because an in-flow
box reflows its siblings while it travels no matter where its transition is
declared.

Two traps make the in-flow approach specifically unfixable:

- `zen-mode.css` is mounted behind `<Show when={zenModeEnabled()}>`. Every
  declaration in it — including `transition:` — vanishes at the instant zen
  turns off. Scoping a transition to `:root[zenmode]` therefore means it
  eases out and snaps back.
- `engine-chrome.css` (the flattened lepton skin) applies
  `transition: all !important` to `#sidebar-main` unconditionally. No rule
  in `zen-mode.css` can prevent that element's margin from animating.

## 2. The mechanism that works: the page covers the chrome

`#tabbrowser-tabbox` is lifted out of the flow under zen
(`position: absolute; inset: 0`) and the chrome stays exactly where it sits
underneath, transparent and click-through. Revealing fades it back in *in
place*, over the page.

Nothing is measured, because nothing retracts by a distance. That deleted
both sidebar width variables, the `ResizeObserver` that kept them true, the
`[zenmode-rebase]` attribute that suppressed the slide while they were
re-taken, and its two-frame `requestAnimationFrame` removal. The toolbox
and status bar already worked this way at the top and bottom edges,
retracting under their own height with `translateY(±100%)`.

It also puts the side edges permanently out of reach of the
`engine-chrome.css` blanket rule: opacity is free to animate because it
cannot reflow anything.

The cost is that the reveal is a fade rather than a slide. Sliding would
need the panel box to clear the icon strip on its way out, which means a
pixel constant back in the CSS — the one thing this design removes.

## 3. Chrome toggles must be per-window

Module scope in the chrome bundle is **per-window** — each window loads its
own copy — so a module-level `createSignal` is window-local. That is how
zen's enabled state stays per window, and it is the pattern to copy.

Two things break it:

**Writing a pref-backed store.** The workspaces rail derived its visibility
straight from `configStore.manageOnBms`, which carries a
`Services.prefs.addObserver` in `workspaces/data/config.ts`. Every window
observed it, so `Alt+Cmd+W` in one window moved the rail in all of them.
Zen, the panel sidebar and the address bar were all correctly window-local;
the rail was the only one of the four that reached outside its own window.

The fix is a window-local signal where `null` means "not been told either
way, follow the preference", so windows still open in the saved state and
stop following only once their own toggle has been used. The toggle
deliberately does **not** write the pref: that pref is the default a new
window opens with, and writing it on every toggle is what leaked in the
first place — any window that had not yet overridden would still follow
along.

**The gesture action registry.** `gestureActions`
(`mouse-gesture/utils/gestures.ts`) is a process-wide singleton whose Map is
keyed by action name:

```ts
public registerAction(action: GestureActionRegistration): void {
  this.actions.set(action.name, action);   // last window to open wins
}
```

Each window's `registerActions` therefore **overwrites** the previous
window's closure. `GestureActionFn` is `(win: Window) => void` for exactly
this reason — always use the passed `win`, never close over the registering
window. Per-window hooks are published on each window as
`gBorkPanelToggles`.

The keyboard controller itself is scrupulous about this: it holds a
`targetWindow` and calls `fn(this.targetWindow)`. Bugs here come from
actions that discard what they are given.

## 4. The dev cycle: three ways to measure stale code

Each of these produces a confident, wrong reading.

**`pkill -f "feles-build stage"` orphans its vite children.** They survive
with `PPID 1` and keep holding their ports. The next stage finds those ports
taken, silently falls back to others, and any browser pinned to the
originals carries on being served the *old* chrome. Reverted source on
disk, stale code on screen, nothing logged. Kill the `npm:vite` processes
explicitly and verify none remain.

**The sweep range 5170–5190 is too narrow.** A vite server was found
orphaned on **5192**, still running from the previous day, having survived
every reset cycle. Sweep at least 5170–5195 and confirm with
`pgrep -f "npm:vite"` returning zero rather than trusting the port scan.

**Killing the stage does not kill the browser.** It keeps running and holds
`_dist/profile/test`. Deleting `.parentlock` out from under a live process
makes the *next* launch exit instantly with no error at all — the log shows
`Launching browser…` followed by `[launcher] Browser Closed` and nothing
else. Kill the browser first (match on the `_dist/` path so an installed
app elsewhere is untouched), confirm `lsof +D _dist/profile/test` is empty,
*then* clear locks.

### Port roles

| Port | Serves |
|------|--------|
| 5181 | the chrome loader (`/loader/index.ts`) |
| 5186 / 5187 / 5188 | the newtab, welcome and notes pages |

The page ports are baked into an installed app's
`Contents/Resources`, so a locally installed build depends on them being up.

### What does not hot-reload

- **Skin CSS** (`skin/bork/css/*.css`) is a `chrome://` stylesheet. It needs
  a full restage.
- **`zen-mode.css`** is imported with `?inline`, so its text is baked into
  the module at evaluation. `dev-tool rebuild` will not apply changes to it
  either.

### Verify what is live, not what is on disk

Ask the browser for its mounted rules rather than reading the source tree:

```js
// via: deno task dev-tool eval '<script>'
let n = 0, marker = 0;
for (const s of document.styleSheets) {
  let rules; try { rules = s.cssRules; } catch { continue; }
  for (const r of rules) {
    const t = r.cssText || "";
    if (!t.includes("zenmode")) continue;
    n++;
    if (t.includes("tabbrowser-tabbox")) marker++;
  }
}
```

Note that `zen-mode.css` is only mounted while zen is **on**, so a rule
count taken with zen off proves nothing.

### Testing multi-window behaviour

Enumerate every window and read them all, rather than trusting the one
Marionette happens to be attached to:

```js
const wins = [];
const e = Services.wm.getEnumerator("navigator:browser");
while (e.hasMoreElements()) wins.push(e.getNext());
```

Fire a real chord at one window and assert on the others:

```js
const w = wins[1];
w.dispatchEvent(new w.KeyboardEvent("keydown", {
  key: "w", code: "KeyW", altKey: true, metaKey: true,
  bubbles: true, cancelable: true,
}));
```

Test with **three** windows, and fire at the *first-opened* one. With two
windows a last-registration-wins bug can pass by coincidence.

### Other measurement traps

- Do not toggle zen by setting the `zenmode` attribute directly. The
  stylesheet is not mounted, so no zen rule matches and you get a false
  "not applying". Use the real toggle.
- Solid's effects flush asynchronously. Reading geometry in the same
  synchronous block as the toggle that changed it races the state change;
  measure in a separate call.
- `requestAnimationFrame` is throttled in a backgrounded window, so
  per-frame sampling silently returns a handful of frames. Prefer asking
  for computed style and `getAnimations()` over sampling a transition.
- `auto → 0` does not interpolate. Collapsing something whose natural size
  is `auto` needs a measured number published first (this is why the nav bar
  hide sets `--bork-navbar-height` before hiding).
- `#urlbar` renders in the top layer: it does not inherit the nav bar's
  opacity and does not collapse with it.
