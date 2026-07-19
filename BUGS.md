# BUGS

Known real bugs that affect **derp**, tracked from upstream Floorp.

derp inherits Floorp's feature layer (`browser-features/`) and forked from
`Floorp-Projects/Floorp` at the #2536 merge (`27ed010972`). Anything fixed
upstream after that point is missing here until ported — but *missing the fix*
is not the same as *having the bug*: derp has rewritten large parts of
workspaces, split-view, tab-stacks and the tabbar, so each item below was
checked against derp's current tree, not assumed.

Verification here is **static** unless a line says otherwise — "present" means
derp's code still has the vulnerable pattern / lacks the fix path, not that the
symptom was reproduced in a running build. Confidence is labelled per item.
Runtime repro is the obvious next step for the behavioural ones.

Assessed 2026-07-19 against upstream through PR #2567.

---

## Fixed in derp

### Web-panel findbar does nothing (Ctrl+F in a sidebar web panel)
- **Upstream:** [#2560](https://github.com/Floorp-Projects/Floorp/pull/2560) (merged)
- **derp status:** **fixed 2026-07-19 (`4b707fae42`)** — ported verbatim from
  upstream. Was real: derp had no find handling in panel-sidebar at all, so
  find commands fell through to browser.xhtml's `gBrowser`-dependent handler,
  which a web-panel window does not satisfy.
- **Fix:** `WebPanelFindController` owns a lazy XUL findbar bound to the panel
  content browser, intercepting find/find-again/find-previous/find-selection in
  the capture phase; wired into `WebsitePanelWindowChild`.
- **Verified:** three files type-check clean in isolation; served bundle in a
  staged build carries the controller; no boot errors. Final visible
  confirmation (findbar appears on Cmd+F in a live web panel) left to a
  manual eyeball — driving the reactive sidebar to mount a web-panel window
  blind via Marionette was impractical.

## Present in derp — fix exists upstream, port available

### PWA install/launch follows the selected tab, not the invoking browser
- **Upstream:** [#2562](https://github.com/Floorp-Projects/Floorp/pull/2562) (merged)
- **derp status:** present. `pwa/ssbManager.ts` resolves the container from
  `globalThis.gBrowser.selectedBrowser` (line ~68) — the exact anti-pattern the
  PR replaces. If the selected tab changes during the install await, or the app
  is invoked for a non-selected browser, install/launch can bind to the wrong
  container.
- **Fix:** resolve the effective container from the browser passed to the
  command; preserve explicit container 0; keep URL/container stable across
  awaits; abort if the invoking browser navigates.
- **Confidence:** medium-high (anti-pattern present verbatim). Edge case:
  container PWAs, or a tab switch mid-install.

### Split-view can strand native tab-drag state
- **Upstream:** [#2561](https://github.com/Floorp-Projects/Floorp/pull/2561) (merged)
- **derp status:** present. No `native-tab-drag-recovery.ts` under
  `split-view/components/`; derp ships split-view. A drag interrupted the wrong
  way (closing/detached tab, lost mouseup) can leave Gecko's `movingtab` state
  or a half-formed split behind.
- **Fix:** let Gecko's bubble-phase `dragend` finalise first; recover only
  after identity/API checks and a null native drag session; retry transient
  sessions up to 1s then fail closed; UI-only finaliser for closing/detached
  tabs.
- **Confidence:** medium (behavioural; fix file absent but derp's split-view is
  heavily diverged, so the surrounding code differs — a port is not a
  drop-in). Worth a runtime repro before porting.

### Workspace replacement-tab container validated via a spoofable DOM attribute
- **Upstream:** [#2563](https://github.com/Floorp-Projects/Floorp/pull/2563) (merged)
- **derp status:** present. `workspacesTabManager.tsx` reads
  `tab.getAttribute("usercontextid")` (lines ~350 and ~549) to decide whether
  Firefox's keep-alive replacement tab is in the right container. That
  attribute is mutable and can disagree with the real origin; there is no
  fail-closed on malformed state.
- **Fix:** track the replacement tab by object identity and validate the
  container from `browsingContext.originAttributes.userContextId`, not the DOM
  attribute; fail closed on malformed origin.
- **Confidence:** medium. Niche — only container ("private"/proxy) workspaces —
  but a correctness bug when it bites.

### Lepton right sidebar clipped on Gecko 152
- **Upstream:** [#2557](https://github.com/Floorp-Projects/Floorp/pull/2557) (merged)
- **derp status:** likely present. No handling of Gecko 152's presence-only
  `sidebar-positionend` attribute anywhere under `designs/`; derp runs the
  FF152 runtime and ships the design layer. Upstream reported a clipped 42px
  sidebar in Lepton overlap mode with the sidebar on the right.
- **Fix:** recognise the presence-only `sidebar-positionend` attribute while
  keeping the legacy `positionend` selector for older Gecko.
- **Confidence:** medium — depends on derp exposing Lepton overlap mode with a
  right-positioned sidebar; the code path is simply absent, so if that config
  is reachable it clips. Cosmetic. **Confirm derp ships this Lepton mode before
  porting.**

---

## Open upstream, no fix yet — plausibly affects derp

These are reported against Floorp and unfixed anywhere. derp shares the
implicated code, so they plausibly reproduce here, but none is verified in
derp — each needs a runtime repro.

### Tab width and scrolling break when split tabs are enabled (horizontal mode)
- **Upstream:** [#2565](https://github.com/Floorp-Projects/Floorp/issues/2565) (open)
- **derp status:** unverified. Touches split-view + the horizontal tabbar,
  both heavily modified in derp — could behave the same, better, or worse.
- **Confidence:** plausible; needs repro. If derp reproduces, it interacts with
  derp's own tabbar/tab-stacks work and is worth a close look.

### Moving a tab stack in Split View to a new window leaves the last tab unloaded
- **Upstream:** [#2567](https://github.com/Floorp-Projects/Floorp/issues/2567) (open, no fix)
- **derp status:** **not confirmed in derp** — investigated 2026-07-19, left
  as-is. The repro needs a specific multi-window state (per the reporter, it
  *only* happens when the original window already holds another Split View),
  then a stack dragged/moved to a new window, then the last tab checked for
  loaded vs lazy. derp's split-view has no clean programmatic activation entry
  point (it is driven through selection / drag / context menu), so the state
  cannot be reliably assembled blind via Marionette, and derp's split-view is
  heavily diverged from upstream, so upstream reproducing does not imply derp
  does. `gBrowser.replaceTabWithWindow(tab)` is the move primitive; the likely
  locus if it is real here is tab adoption across windows interacting with
  split-view session-restore (`split-view/patches/session-restore.ts`) and the
  `floorpSplitViewGroupId` persistence patch.
- **Next step:** a **visual** repro (loaded vs lazy is obvious on screen). No
  fix should be written until the bug is confirmed present in derp. Reporter is
  on Fedora Linux; behaviour may differ on macOS.
- **Confidence:** real upstream; unconfirmed in derp.

---

## Assessed and NOT a derp bug — recorded so we don't re-chase

### Closing a tab in an all-new-tab workspace switches to another workspace
- **Upstream:** [#2564](https://github.com/Floorp-Projects/Floorp/issues/2564)
  (open upstream), [#2563 area]
- **derp status:** **already fixed in derp**, independently. `handleTabClose`
  stays in the current workspace with a fresh/adopted tab instead of jumping to
  another workspace (see the "derp: stay in the current workspace" comment in
  `workspacesTabManager.tsx`). Upstream still has it; derp does not.

### Mouse-gesture wheel double-finalise / residual context menu
- **Upstream:** [#2559](https://github.com/Floorp-Projects/Floorp/pull/2559) (merged)
- **derp status:** **independently handled**, not clearly a derp bug. derp's
  `mouse-gesture/controller.ts` already suppresses the residual context menu
  (`isContextMenuPrevented` + prevention timeout) and recovers stuck gesture
  state on popup-shown. The specific "one interaction = one command" latch may
  still differ, but the class of problem the PR addresses is covered. Low
  priority; revisit only if a wheel-gesture misfire is actually seen.

### About-dialog strings not localised
- **Upstream:** [#2558](https://github.com/Floorp-Projects/Floorp/pull/2558) (merged)
- **derp status:** largely moot. derp has rebranded the About surfaces; the
  untranslated upstream literals are not derp's copy. No action unless derp
  wants ja-JP parity on its own About text.
