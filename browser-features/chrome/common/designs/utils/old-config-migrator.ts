/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const getOldInterfaceConfig = () => {
  // derp keeps only two interfaces: lepton and derp. Legacy Floorp
  // interface prefs (photon/protonfix under interface=3, fluerial under
  // interface=8 — all removed) collapse to lepton, their nearest surviving
  // sibling. A fresh profile (no legacy pref) defaults to derp, the fork's
  // own interface.
  switch (Services.prefs.getIntPref("floorp.browser.user.interface", 0)) {
    case 3:
    case 8:
      return "lepton";
  }

  return "derp";
};

export const getOldTabbarStyleConfig = () => {
  // Legacy style=2 was vertical — removed from derp entirely; those
  // profiles fall back to the horizontal strip.
  switch (Services.prefs.getIntPref("floorp.tabbar.style", 0)) {
    case 1:
      return "multirow";
    default:
      return "horizontal";
  }
};

export const getOldTabbarPositionConfig = () => {
  switch (Services.prefs.getIntPref("floorp.browser.tabbar.settings", 0)) {
    case 1:
      return "hide-horizontal-tabbar";
    case 2:
      return "optimise-to-vertical-tabbar";
    case 3:
      return "bottom-of-navigation-toolbar";
    case 4:
      return "bottom-of-window";
    default:
      return "default";
  }
};
