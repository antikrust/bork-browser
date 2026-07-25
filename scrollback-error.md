# scrollback-error — two separate tab-strip scroll bugs, both FIXED

**Two different bugs live in this file. Check which symptom you have:**

| Symptom | Row | Status |
| --- | --- | --- |
| The strip **scrolls itself back** toward where it was after you scroll away | row 1 | fixed 2026-07-17, [below](#2026-07-17-resolution) |
| Scrolling row 2 kills **page** scrolling for ~25s; recovers with a jerk, or instantly if you type | row 2 | fixed 2026-07-25, next section |

---

# Row 2 froze page scrolling (FIXED — user-validated 2026-07-25)

**Cause: the `<arrowscrollbox>` itself.** Row 2 became one in `eff859f474`
(2026-07-16), which is the earliest point the bug can exist; the user confirmed
it was present in builds from 07-21 and 07-23. Replacing it with a plain
`<hbox>` (`312901f058`) ended it — user-confirmed, and the decisive test, since
building the 07-16 commit against today's runtime is impossible (that feature
layer ships the PWA/SSB component the runtime dropped on 07-23).

Eliminated by the user before that: Dark Bork, `floorp.tabstrip.wheelguard`
(that pref only guards row 1), and any runtime change (the runtime binary had
not moved since 07-23 17:28).

**What in the widget does it.** Both of these are stock toolkit code, read out
of `toolkit/content/widgets/arrowscrollbox.js` in the runtime checkout:

1. `on_wheel` ends with `event.stopPropagation(); event.preventDefault();`
   **outside** the `if (doScroll)` block, so *every* wheel event is consumed
   while the box is `[overflowing]` — including the ones it chose not to act on.
   It ignores a lot of them: the `_prevMouseScrolls` filter (length 2) drops
   events until two in a row agree on an axis, which on a trackpad is constant.
   The consequence is in `EventStateManager::PostHandleEvent`:

   ```
   case eWheel:
     if (*aStatus == nsEventStatus_eConsumeNoDefault) {
       ScrollbarsForWheel::Inactivate(); break;
     }
   ```

   — `preventDefault` skips the **whole** wheel default-action path: scroll
   target computation, the wheel transaction, the APZ handoff.

2. `_arrowScrollAnim.sample()` reschedules itself every frame with **no exit
   condition at all** — no `isConnected`, no `_mousedown`, not even the
   `!document` check its sibling timer callback has. Only an explicit
   `_stopScroll()` ends it, and that needs a mouseup landing inside the widget's
   own shadow root. `_onButtonMouseOver → _continueScroll → _startScroll`
   restarts it from a plain hover once `_mousedown` has latched. Already on
   record in `CLAUDE.md` as freezing page scroll until an unrelated blur/mouseup.

**Which of the two delivered the user's 25 seconds is not established.** Proving
it needs instrumentation on a build that still has the bug, and the bug was not
reintroduced to find out. The replacement avoids both.

**Why typing cleared it.** `WheelTransaction::OnEvent`
(`dom/events/WheelHandlingHelper.cpp`) ends the transaction on
`eKeyDown`/`eKeyPress`/`eMouseDown`. That is the only path in the engine where a
keystroke fixes a scrolling problem — and it also rules out a janked main
thread, which would not have let the user type at all. **Keep this as a
diagnostic.**

**The replacement** (`tab-stacks/stack-bar.tsx` + `styles.css`), structured to
mirror row 1's `[scroller][arrow][+]`:

- plain `<hbox id="bork-stack-scroller">` with `overflow-x: auto` — no wheel
  handler of any kind, the compositor scrolls it
- two `toolbarbutton`s using row 1's `arrow-left.svg` with the right one
  mirrored, driven by the same `[overflowing]` / `[scrolledtostart]` /
  `[scrolledtoend]` attributes `tabs.css` keys off
- hold-to-scroll with every exit the toolkit's lacks — released, pointer left
  the button, window blurred, element detached, component unmounted — plus
  `onCleanup` cancelling the frame; release snaps to a cell edge the way
  `_stopScroll` snaps by index
- one `ResizeObserver` over the scroller and its content box, writing attributes
  **only on change** so it cannot feed itself. Arrow visibility is bistable, not
  oscillating: showing them narrows the scroller, hiding widens it, and a row
  that already fits still fits.

**Dead ends from this hunt — do not redo:** two "fixes" claimed without a
reproduction (reverted, `ce904bb61a` and `992853a228`); a global
`mousewheel.transaction.timeout` pref (the freeze outlasts 1500ms by far, and
the transaction is never even created for row 2 — `preventDefault` means
`WillHandleDefaultAction` is not reached).

---

# Row 1 snapped back after scrolling away (FIXED — user-validated 2026-07-17)

Validation-session counters (real trackpad): reversalDropped 217,
recentresSuppressed 28, axisDropped 7 — all three mechanisms live in one
session, all caught, user confirmed the snap-back is gone.

## 2026-07-17 RESOLUTION

**Cause found, fix shipped, mechanism proven synthetically.** It is stock
Firefox toolkit behavior, not bork code: `arrowscrollbox.on_wheel` maps
vertical (`deltaY`-dominant) pixel wheel events onto horizontal scrolling
("vertical wheel scrolls a horizontal scrollbox"), behind only a 2-event
axis filter (`_prevMouseScrolls`, length 2). On release, the macOS momentum
tail follows the **lift velocity**, not the drag direction — a horizontal
strip-scroll ending with any vertical flick hands over to a
vertical-dominant decaying tail, which from its 3rd event passes the filter
and scrolls the strip back. Positive `deltaY` = rightward; with the
selected tab far right the strip was parked at max scroll, so the clamped
return landed exactly "back at the selected tab".

Why earlier synthetic attempts failed to reproduce: they never sent a
*vertical-dominant* tail. Sending one via
`windowUtils.sendWheelEvent(..., WHEEL_EVENT_CAUSED_BY_MOMENTUM)` after a
horizontal stream reproduces the snap-back on demand: **+71.5px backward
with the fix off, 0px with it on** (measured live 2026-07-17).

**Fix**: `browser-features/chrome/common/tab-strip-wheel-guard/` — a
capture-phase wheel filter on `#tabbrowser-tabs`, ahead of every strip
listener, pixel-mode events only (mouse wheels untouched):

- **axis quarantine** — vertical-dominant events may not continue a
  gapless (<400ms) horizontal-dominant stream; a deliberate vertical
  strip-scroll starts its own stream and still works (verified +24px).
- **reversal hold** — a same-axis direction reversal inside a gapless
  stream is dropped while it stays under the run's **peak envelope**
  (tails enter at peak and decay; a live finger enters near zero and
  clears its own tiny peak within an event or two — verified both ways).

Two revisions after the first real-trackpad session (user still saw the
snap; readout showed the guard engaged 23× then leaked):

1. v1 released the hold when an event grew 15% past the *previous* one —
   real tails jitter (…13, 12, 15, 11…) and one uptick re-latched the
   reversed direction, passing the rest of the tail. Now release requires
   clearing the run's PEAK (a decaying tail never climbs back above its
   entry peak). The user's counters also showed the real tail is
   *diagonal* (18 same-axis + 5 cross-axis drops), so both rules carry.
2. The stream model now OBSERVES every strip wheel event even while
   enforcement is off ([overflowing] absent — happens transiently right
   after session restore, seen on two consecutive relaunches). v1 went
   blind in that window, so a tail arriving right after it latched as a
   fresh gesture and passed wholesale. Verified with an explicit
   blind-window test: 17/17 tail events dropped after a blind drag.

**Third mechanism found after the second real-trackpad session** (user:
"snaps back to the leftmost tab when it's selected"): the SELECTION
recentre. tabs.js re-runs ensureTabIsVisible(selectedTab) on every strip
resize (handleResize -> _handleTabSelect), and resizes trail manual
scrolling with a delay (lazy tab rendering settling, stack-bar/button
churn) — this path is invisible to the wheel rules (it is not wheel
events) and the old tab-stacks wrap only skipped HIDDEN stacked tabs, so
a visible selected tab still yanked the strip back. Fix: **recentre
latch** — a manual wheel over the strip marks it user-positioned for the
current selected tab; while the selection is unchanged, resize-driven
recentres onto that tab are skipped. Selecting any tab ends the
suppression (by identity — no listener-ordering races), so genuine
select-recentres still work (verified: suppressed while armed, 585px
recentre passes on real selection change, re-arms after next wheel).

**Elimination switch** (int pref bitfield, no relaunch needed):
`floorp.tabstrip.wheelguard` = 1 axis quarantine + 2 reversal hold +
4 recentre latch; default 7 (all), 0 = stock. Readout after a repro
attempt:
`deno task dev-tool eval 'JSON.stringify(globalThis.__borkWheelGuard)'` —
axisDropped / reversalDropped / recentresSuppressed say which mechanism
fired on that gesture.

Remaining validation: one real trackpad session. If the snap-back is gone
and `axisDropped` > 0, hypothesis (a) (vertical tail) is confirmed; if
`reversalDropped` carried the load instead, the tail was same-axis
reversed. Either way the fix covers both. The old open items below are
kept for history; hypotheses 3 (scroll-snap: none exists on the strip in
this runtime or the bork skin) and 4 (untrusted dispatchers: none exist in
the tree) were eliminated by inspection.

---

Original handoff document below (status as of the morning of 2026-07-17):
root cause narrowed but not found; two real mechanisms were eliminated
with evidence; the remaining generator was unidentified.

## Symptom

With the tab strip overflowing and the **selected tab inside a tab stack at
the far right** (possibly any far position), the user scrolls the strip away
(leftward). After releasing, the strip **scrolls itself back** toward where
it was — repeatedly, feels like a spring. Reported "several times" per
gesture. Happens with real trackpad input on macOS; never reproduced with
synthetic events.

- Machine: macOS (Darwin 24.5), trackpad (momentum scrolling).
- Build: bork (Floorp 12 fork), FF152 runtime, stage mode
  (`deno task feles-build stage --marionette`).
- Row 2 (bork's stack bar) is NOT involved **in this bug** — user confirmed the
  jump is the top row; probes confirmed no programmatic scrolls of the top strip
  from bork code. (Row 2 had its own, unrelated scroll bug — first section.)

## Hard evidence collected

### Probe 1 — caught a real mechanism (fixed, but symptom persisted)

A logging wrapper on `gBrowser.tabContainer.arrowScrollbox.ensureElementIsVisible`
during a live user reproduction captured **17 identical stacks**:

```
ensureTabIsVisible <- _handleTabSelect <- handleResize   (tabbrowser/tabs.js)
el = the selected tab, hidden (a stack member; zero width at the chip)
```

Firefox re-centres the strip on the selected tab on every strip resize.
Manual scrolling toggles the overflow scroll buttons → resizes the strip →
fires this. With the selected tab being a hidden stack member, the strip
scrolled back to the chip.

**Fix shipped** (commit `6999524c6c`, tab-stacks/index.ts): wrap
`arrowScrollbox.ensureElementIsVisible` to no-op when the target is hidden
or zero-width. Verified live: a real window resize fires the wrap 6× on the
hidden member and the strip stays put. **This mechanism is dead — but the
user's symptom continued**, so it was at most a contributor.

### Probe 2 — the surviving mechanism is wheel events

A wider probe wrapped `ensureElementIsVisible`, `scrollByPixels`,
`scrollTo`, `scrollBy` and logged every call with the scroll delta it caused
plus a stack trace. During a full user reproduction (349 log entries):

- `ensureElementIsVisible`: fired, moved **0px** every time (wrap works).
- `scrollTo` / `scrollBy`: never called.
- **Every pixel of movement came through `scrollByPixels` from
  `on_wheel@arrowscrollbox.js`** — i.e. real wheel events reaching the
  strip's wheel handler.

Sign-run analysis of those wheel deltas (argument px, chronological):

```
-x75  (-297px)   user scrolls away (left)
+x85  (+454px)   "snap back": 85 small rightward events, decaying 18,16,15,13,12,11,...,1
-x112 (-1223px)  user scrolls away harder
+x75  (+671px)   snap back again, same decaying shape
```

The decay curve is machine-like (momentum/spring), not human.

### Discrimination test 1 — APZ overscroll: NOT the cause

`apz.overscroll.enabled=false` set live (user pref), user reproduced again:
**same pattern** (e.g. `-x89(-1593px) +x77(+1087px)`, `-x119(-1108px)
+x27(+491px)` …). The elastic-overscroll hypothesis (which the user
suggested first) is eliminated. Pref restored to default true afterwards
(`Services.prefs.clearUserPref("apz.overscroll.enabled")`).

### Discrimination test 2 — direction-latch wheel guard: DID NOT FIX

A capture-phase wheel listener on the arrowscrollbox latched the direction
of each wheel stream (new stream = >150ms gap) and swallowed
opposite-direction events within a stream
(`preventDefault + stopImmediatePropagation`). User still saw the snap-back.

**Lost data (browser closed before harvest):** whether the guard's swallow
counter was actually >0 during that repro, and the recorded WheelEvent
property probe (`momentum`/`mozMomentum`/`phase`/`mozInputSource`
presence). So it is NOT yet known whether:
- (a) the reversed events restart streams with >150ms gaps (latch resets, so
  nothing swallowed → guard logic never engaged), or
- (b) events were swallowed but the strip scrolled anyway (→ movement is not
  going through DOM wheel events at that point at all — contradicting probe
  2 — or a second listener/path exists).

Re-establishing (a) vs (b) is the highest-value next measurement.

## What is established

1. No bork code scrolls the top strip. The only scroll-into-view bork has
   targets `#bork-stack-bar` (row 2) and fires only on drops.
2. No Firefox scroll-to-selected call moves it (wrap no-ops it; probes show
   0px movement from that path).
3. The snap-back is delivered to the strip as a **stream of reversed,
   decaying wheel deltas** consumed by `arrowscrollbox on_wheel →
   scrollByPixels`.
4. It is not APZ overscroll.
5. It needs real trackpad input; synthetic `WheelEvent` dispatch and
   synthetic resizes never reproduced the reversed streams.

## Open hypotheses (ranked)

1. **macOS widget-layer momentum reversal**: Gecko's macOS widget code (pan
   gesture / `SwipeTracker` / pixel-scroll momentum) generates the reversed
   spring events when a momentum flick hits the scroll limit of the wheel
   *transaction target*. Wheel transactions on the strip might also be
   retargeted mid-momentum. Investigate `widget/cocoa` momentum handling and
   wheel transaction code; check prefs `mousewheel.transaction.*`,
   `apz.momentum*`, `general.smoothScroll.*`.
2. **Wheel transaction retarget from content**: if the gesture starts over
   page content and momentum continues after the pointer crosses into the
   strip (or vice versa), momentum events follow the transaction; a bounce
   in the content scroller could be delivered while the strip is the target.
   Test: reproduce with the pointer kept strictly inside the strip the whole
   time vs. drifting.
3. **Scroll-snap on the strip's shadow scrollbox**: FF152's tabs CSS might
   set `scroll-snap-type` on `[part=scrollbox]` / snap-align on tabs. Never
   checked (browser closed first). Check:
   `getComputedStyle(arrowScrollbox.shadowRoot.querySelector('[part=scrollbox]')).scrollSnapType`
   and `scrollSnapAlign` on a tab. A snap would explain "returns to a
   meaningful position"; less well the multi-hundred-px distance.
4. **Something dispatching untrusted wheel events**: enumerate wheel
   listeners (`nsIEventListenerService.getListenerInfoFor`) on the
   arrowscrollbox chain; log `event.isTrusted` in the next probe (was not
   logged — add it).

## Recommended next steps (in order)

1. **One-scroll discriminators the user can do:**
   - Reproduce with an **external mouse** (no momentum). If it never
     happens: momentum machinery confirmed as the carrier.
   - Reproduce with the selected tab being a **plain far-right tab** (no
     stack). User believes "might be any tab" — confirm. If stack-only:
     the hidden-selected-tab state still matters somehow.
   - Reproduce in **stock Firefox 152** (or plain Floorp) with an
     overflowing strip: is this an upstream bug at all?
2. **Re-run the guard probe, harvesting properly**: same direction-latch,
   but log per-event `{delta, timeStamp, isTrusted, latched?, swallowed?}`
   into a ring buffer, and READ IT before any relaunch. This resolves
   unknown (a)/(b) above. Remember: each Marionette eval is an interaction —
   read in the same session, and never rebuild before harvesting
   (`CLAUDE.md` → "Hover/timer tests need one eval" and the Marionette
   notes).
3. Check hypothesis 3 (scroll-snap) — one eval.
4. If widget momentum confirmed: try `mousewheel.default.delta_multiplier_x`
   tricks last; prefer finding the actual reversal source in
   `widget/cocoa/nsChildView.mm` / `PanGestureInput` handling (the runtime
   is prebuilt — pref-level or JS-level mitigations only, unless patching
   via `feles-build misc patch`).

## Dead ends — do not redo

- Wrapping/skipping `ensureElementIsVisible` (done; fixes a real but
  different mechanism; keep it).
- `apz.overscroll.enabled=false` (tested live; no effect on this).
- Naive direction-latch wheel guard at 150ms (did not fix; unknown whether
  it engaged — re-instrument before reusing the idea).
- Synthetic reproduction (wheel/resize/TabSelect dispatch): cannot trigger
  the reversed streams; only real trackpad input shows it.

## Tooling crib (see CLAUDE.md for the full rules)

- Launch: `deno task feles-build stage --marionette` (full cycle required
  after ANY code edit; sweep ports 5170–5190 first; recreate
  `_dist/marionette-port.txt` with `echo 2828 > _dist/marionette-port.txt`).
- Probe pattern (chrome eval, single expression):
  `deno task dev-tool eval '(function(){ ... })()'`
- The arrowscrollbox: `gBrowser.tabContainer.arrowScrollbox`; its real
  scroller is `shadowRoot.querySelector("[part=scrollbox]")` (the host's
  own `scrollWidth` lies).
- Time-dependent checks must run inside ONE eval via
  `Services.tm.spinEventLoopUntil(...)`.
- All live patches (wrappers, listeners, logs) die on relaunch — harvest
  before rebuilding, and re-inject after.
