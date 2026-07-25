/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { onCleanup } from "solid-js";
import {
  noraComponent,
  NoraComponentBase,
} from "#features-chrome/utils/base.ts";
import type { GuardedScrollbox, TabBrowserLike } from "./types.ts";
import {
  attachReleaseWatchdog,
  attachWheelGuard,
  getWheelGuardReadout,
  GUARD_DEFAULT,
  GUARD_PREF,
  RECENTRE_RULE,
} from "./attach.ts";

/**
 * Stops the overflowing tab strip "snapping back" after a trackpad scroll.
 *
 * The snap-back is delivered as real wheel events: after the fingers lift,
 * macOS emits a decaying momentum tail whose axis mix follows the lift
 * velocity, not the drag — so a horizontal strip-scroll can hand over to a
 * vertical-dominant (or reversed) tail. Stock arrowscrollbox maps deltaY
 * onto horizontal scrolling ("vertical wheel scrolls a horizontal
 * scrollbox") behind only a 2-event axis filter, so from the tail's third
 * event the strip scrolls back against the drag it just finished.
 *
 * The two wheel rules now live in attach.ts and are applied to EVERY
 * horizontal arrowscrollbox — the stack bar (row 2) is the same widget and was
 * still snapping back while only the strip was guarded. See scrollback-error.md
 * and attach.ts for the mechanism; the strip-only third rule stays here:
 *
 *  - recentre latch: Firefox re-runs ensureTabIsVisible(selectedTab) on every
 *    strip resize (tabs.js handleResize -> _handleTabSelect), and strip resizes
 *    trail manual scrolling with a delay (lazy tab rendering settling,
 *    scroll-button and stack-bar churn) — yanking the strip back to the
 *    selected tab seconds after the user scrolled away from it. A manual wheel
 *    over the strip marks it user-positioned for the CURRENT selected tab;
 *    while the selection is unchanged, resize-driven recentres onto that tab
 *    are skipped. Selecting any tab (the only recentre the user actually asked
 *    for) ends the suppression by identity, so no listener ordering is
 *    involved.
 *
 * Pref (int) floorp.tabstrip.wheelguard — bitfield: 1 axis quarantine |
 * 2 reversal hold | 4 recentre latch; default 7 (all). Flip to 0 for
 * stock behavior. Readout at globalThis.__borkWheelGuard says which
 * rules engaged.
 */

@noraComponent(import.meta.hot)
export default class TabStripWheelGuard extends NoraComponentBase {
  init(): void {
    const tabContainer = document?.getElementById("tabbrowser-tabs");
    const asb = document?.getElementById(
      "tabbrowser-arrowscrollbox",
    ) as GuardedScrollbox | null;
    if (!tabContainer || !asb) {
      this.logger.warn("tab strip not found; guard not attached");
      return;
    }

    const readout = getWheelGuardReadout();

    const getSelectedTab = (): Element | null =>
      (globalThis as { gBrowser?: TabBrowserLike }).gBrowser?.selectedTab ??
        null;

    let errorReported = false;
    // The tab whose resize-driven recentres are suppressed because the
    // user manually positioned the strip while it was selected. Cleared
    // by identity: any selection change makes it stale.
    let userPositionedFor: Element | null = null;

    const detachGuard = attachWheelGuard({
      asb,
      listenOn: tabContainer,
      readout,
      // Any manual wheel over the strip — pixel or line mode — is the user
      // positioning it; arm the recentre latch for the selected tab.
      onManualWheel: () => {
        userPositionedFor = getSelectedTab();
      },
    });

    // The strip's arrows leak the same click-to-scroll loop as the stack bar's
    // (the left arrow disables itself at the start, so the release is never
    // seen); watchdog it here too.
    const detachWatchdog = attachReleaseWatchdog(asb);

    // Recentre latch: intercept Firefox's resize-driven scroll-to-selected
    // (tabs.js handleResize -> _handleTabSelect -> ensureTabIsVisible).
    // Composes with tab-stacks' hidden-tab wrap — each skips on its own
    // condition and calls through otherwise.
    if (!asb.__borkRecentreWrapped) {
      const origEnsure = asb.ensureElementIsVisible.bind(asb);
      asb.ensureElementIsVisible = (el: Element, instant?: boolean) => {
        try {
          const mode = Services.prefs.getIntPref(GUARD_PREF, GUARD_DEFAULT);
          if ((mode & RECENTRE_RULE) !== 0 && userPositionedFor) {
            const selected = getSelectedTab();
            if (selected !== userPositionedFor) {
              // Selection changed since the user positioned the strip —
              // suppression is over, recentres are legitimate again.
              userPositionedFor = null;
            } else if (el === selected) {
              readout.recentresSuppressed += 1;
              return;
            }
          }
        } catch (e) {
          if (!errorReported) {
            errorReported = true;
            console.error("[TabStripWheelGuard]", e);
          }
        }
        return origEnsure(el, instant);
      };
      asb.__borkRecentreWrapped = true;
      onCleanup(() => {
        asb.ensureElementIsVisible = origEnsure;
        asb.__borkRecentreWrapped = false;
      });
    }
    this.logger.debug("attached");

    onCleanup(() => {
      detachGuard();
      detachWatchdog();
      // The readout is left in place: it is shared with the stack bar's guard,
      // which may still be attached.
    });
  }
}
