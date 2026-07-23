## Environment

- Floorp 12 (Noraneko feature layer) on Floorp-runtime daily (FF 152.0), macOS (Darwin 24.5)
- **Mac mini with a Magic Mouse** — the momentum scrolling comes from the mouse's touch surface, not a trackpad
- Overflowing horizontal tab strip (70+ tabs)
- One machine, one pointing device. Not yet tried with another mouse or with a trackpad.

## Symptom

With the tab strip overflowing, scroll the strip away from the selected tab and let go. The strip repeatedly scrolls itself back — either as a decaying "spring" motion right after the gesture, or as a delayed jump back to the selected tab seconds later. It feels random, but it is reproducible.

## Status: still investigating

We instrumented a fork ([100mountains/bork](https://github.com/100mountains/bork)) and found **three candidate mechanisms** in stock toolkit/browser code that Floorp inherits from the runtime. We also ship a mitigation that removes the symptom on this machine.

What we have **not** established is which of the three actually drives what the user sees, or whether all three are needed. The evidence differs per candidate and is noted below. Filing now because the code paths look general rather than Floorp-specific, and someone may recognise them.

## Candidate 1 — reversed momentum tails (wheel-borne)

After the finger lifts, macOS delivers a decaying momentum tail. On this device the tail frequently arrives **direction-reversed relative to the drag** on the same axis. A logging wrapper on the strip's `arrowscrollbox` captured the shape during live reproductions (sign-runs of `scrollByPixels` deltas via `on_wheel`):

```
-x75  (-297px)   user scrolls away (left)
+x85  (+454px)   snap back: 85 events decaying 18,16,15,13,12,11,...,1
-x112 (-1223px)  user scrolls away harder
+x75  (+671px)   same decaying shape again
```

`apz.overscroll.enabled=false` changes nothing, so this is not APZ overscroll.

*Evidence: logged event streams during live reproduction. We cannot say whether this reversal is ordinary macOS momentum behaviour being mishandled downstream, or something particular to this device.*

## Candidate 2 — vertical-dominant momentum tails mapped onto horizontal scrolling

`arrowscrollbox.on_wheel` deliberately maps vertical (`deltaY`-dominant) pixel events onto horizontal scrolling ("many users have a vertical scroll wheel but no horizontal support"), gated only by the 2-event `_prevMouseScrolls` axis filter. A momentum tail follows lift velocity rather than drag direction, so ending a horizontal drag with a slight vertical flick produces a vertical-dominant tail. It passes the 2-event filter from its third event and drives the strip backward.

This may also be why the behaviour resists synthetic reproduction: a vertical-dominant decaying tail is not what a test would normally generate. Sending exactly that via `windowUtils.sendWheelEvent(..., WHEEL_EVENT_CAUSED_BY_MOMENTUM)` after a horizontal stream did reproduce a snap-back on demand (+71.5px backward; 0px with the mitigation active).

*Evidence: the strongest of the three — a synthetic reproduction isolating this path, plus the code gate itself.*

## Candidate 3 — selection recentre on strip resize (not wheel-borne)

`tabs.js` re-runs `ensureTabIsVisible(selectedTab)` on every strip resize (`handleResize` → `_handleTabSelect`), and resizes trail manual scrolling with a delay (lazy tab rendering settling, scroll-button churn). That would produce a jump back to the selected tab seconds after scrolling away from it. A stack probe during a live reproduction caught 17 consecutive `ensureElementIsVisible` calls from this path.

*Evidence: a stack probe showing the calls happening. We have not proven those particular calls produced the movement the user noticed.*

## What we have not done

- **Isolated the mechanisms.** The mitigation is pref-gated as a bitfield (`floorp.tabstrip.wheelguard`, 1|2|4, default all, 0 = stock) precisely so each rule can be switched off on its own — but we have not yet run that elimination. Until we do, "three mechanisms" is a hypothesis rather than a finding.
- **Tested other hardware.** One Mac mini, one Magic Mouse. Whether a different mouse, a trackpad or another machine behaves the same is unknown. We would expect similar behaviour from other momentum-capable devices, but that is an expectation, not a result.
- **Attributed the counters.** In one validation session the per-rule counters read reversal 217, recentre 28, axis 7. That shows each rule engaging — not that each was individually responsible for visible movement.

## Mitigation we currently ship

[`browser-features/chrome/common/tab-strip-wheel-guard/`](https://github.com/100mountains/bork/tree/main/browser-features/chrome/common/tab-strip-wheel-guard) (commit [`52088a676f`](https://github.com/100mountains/bork/commit/52088a676f)) — a capture-phase wheel filter ahead of the strip's listeners plus a wrap on `ensureElementIsVisible`:

1. **Axis quarantine** — vertical-dominant pixel events may not continue a gapless (<400 ms) horizontal-dominant stream. Deliberate vertical scrolling over the strip still works, since it starts its own stream.
2. **Reversal hold** — a same-axis direction reversal inside a gapless stream is dropped while it stays under the run's peak envelope. A decaying tail jitters but never climbs back above its entry peak; a live finger reversing enters near zero and clears its own peak within an event or two, which releases the hold.
3. **Recentre latch** — a manual wheel over the strip marks it user-positioned for the current selected tab; while the selection is unchanged, resize-driven recentres onto that tab are skipped. Selecting any tab restores stock behaviour (identity comparison, no listener-ordering dependence).

With all three rules active the snap-back is gone on this machine. That is the clearest result we have, and it is also why we cannot yet say which rule earned it.

## Notes

- Candidates 1–2 are in toolkit `arrowscrollbox.js` and candidate 3 in `tabs.js`, so if these are the cause it is upstream Firefox behaviour that Floorp inherits through the runtime rather than anything Floorp does. Most people never park a selected tab at a strip edge, which may be why it is rarely reported.
- Happy to run the per-rule elimination and report which bits actually matter, if that would be useful before anyone spends time on this.
- Equally happy to port the guard as a PR against the Floorp feature layer — it is self-contained and already uses a `floorp.*` pref namespace — or to route it upstream to Mozilla instead, if that is the better home.
- The mechanism analysis comes from reading the shipped runtime's toolkit code, not from instrumenting Gecko itself. Corrections welcome; we may have the wrong end of this.
