/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const SIDEBAR_HIDDEN_PREF = "derp.sidebar.hidden";
export const SIDEBAR_HIDDEN_ATTR = "derp-sidebar-hidden";

/**
 * THE panel-sidebar toggle: flips the derp-sidebar-hidden root attribute
 * on the given window (the CSS in lean-urlbar/styles.css collapses the
 * panel sidebar boxes off it) and records the new state in
 * derp.sidebar.hidden, which seeds windows opened later.
 *
 * Single mechanism, two callers: the Cmd+Alt+S gesture action registered
 * by lean-urlbar (which additionally honours the derp.sidebar.toggle.enabled
 * fault-finding switch) and the derp-panel-sidebar-button navbar widget
 * (panel-toggles), for which a deliberate click is the enablement.
 */
export function togglePanelSidebar(win: Window): void {
  const root = win.document?.documentElement;
  if (!root) {
    return;
  }
  const next = !root.hasAttribute(SIDEBAR_HIDDEN_ATTR);
  if (next) {
    root.setAttribute(SIDEBAR_HIDDEN_ATTR, "");
  } else {
    root.removeAttribute(SIDEBAR_HIDDEN_ATTR);
  }
  Services.prefs.setBoolPref(SIDEBAR_HIDDEN_PREF, next);
}
