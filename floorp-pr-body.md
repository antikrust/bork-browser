Fixes #2555 (full diagnosis and evidence there).

Adds a self-contained feature `browser-features/chrome/common/tab-strip-wheel-guard/` (auto-discovered, no registry edits) that stops the overflowing tab strip scrolling itself back after trackpad gestures on macOS. Three pref-gated rules, mirroring the three mechanisms in the issue:

1. **Axis quarantine** — vertical-dominant pixel-mode wheel events may not continue a gapless (<400 ms) horizontal-dominant stream, so a vertical-leaning macOS momentum tail no longer drives the horizontal strip backward through `on_wheel`'s deltaY mapping. Deliberate vertical-wheel-over-strip scrolling still works: it starts its own stream after any pause.
2. **Reversal hold** — a same-axis direction reversal inside a gapless stream is dropped while it stays under the run's peak magnitude. Decaying momentum tails jitter but never climb back above their entry peak; a live finger reversing enters near zero and clears its own peak within an event or two, releasing the hold (~2–3 px cost).
3. **Recentre latch** — wraps `arrowScrollbox.ensureElementIsVisible`: after the user manually scrolls the strip, resize-driven recentres onto the *currently selected* tab are skipped until the selection changes (tabs.js re-runs `_handleTabSelect → ensureTabIsVisible(selectedTab)` on every strip resize, and resizes trail scrolling — lazy tab rendering, scroll-button churn — yanking the strip back seconds later). Selecting any tab restores stock recentre behavior; the check is by tab identity, so there is no listener-ordering dependence.

Scope and safety:

- Pixel-mode (`DOM_DELTA_PIXEL`) events only — plain mouse wheels never see the guard.
- Capture-phase listener on `#tabbrowser-tabs`, ahead of the strip's own listeners; drops use `preventDefault + stopImmediatePropagation`.
- `floorp.tabstrip.wheelguard` (int bitfield: 1 axis | 2 reversal | 4 recentre; default 7; `0` = stock behavior with zero interception). If you'd rather land this opt-in, flipping `GUARD_DEFAULT` to 0 is a one-line change.
- Per-rule counters exposed at `globalThis.__borkWheelGuard` so any machine can confirm or rule out each mechanism in one gesture.

Validation honesty: mechanisms verified by synthetic momentum streams (`sendWheelEvent` with `WHEEL_EVENT_CAUSED_BY_MOMENTUM`) against the shipped FF152 runtime, plus live validation on one macOS MacBook trackpad (counters in a single real session: reversal 217, recentre 28, axis 7; snap-back gone with all rules active, present with pref 0). Not yet exercised on Windows precision touchpads or Linux; the rules are inert for non-pixel input by construction.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
