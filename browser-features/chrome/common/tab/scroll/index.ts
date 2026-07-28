/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { config } from "#features-chrome/common/designs/configs.ts";
import { createEffect } from "solid-js";

type XULTabElement = XULElement & {
  on_wheel?: (event: WheelEvent) => void;
  advanceSelectedTab: (aDelta: number, aWrap: boolean) => void;
};

/**
 * Scroll-to-switch-tabs (a Floorp settings toggle). The handler shadows the
 * element's native `on_wheel` (tabs.js routes wheel events through that
 * method), so it is installed only while the feature is on and removed —
 * restoring the native method — when it is off. An always-installed shadow
 * was one of four systems sitting on the strip's wheel path at once; the
 * strip's wheel behaviour is owned by the arrowscrollbox alone.
 */
export class TabScroll {
  private handleOnWheel = (
    event: WheelEvent,
    tabBrowserTabs: XULTabElement,
  ) => {
    if (Services.prefs.getBoolPref("toolkit.tabbox.switchByScrolling")) {
      if (event.deltaY > 0 !== config().tab.tabScroll.reverse) {
        tabBrowserTabs?.advanceSelectedTab(1, config().tab.tabScroll.wrap);
      } else {
        tabBrowserTabs?.advanceSelectedTab(-1, config().tab.tabScroll.wrap);
      }
      event.preventDefault();
      event.stopPropagation();
    }
  };

  constructor() {
    const tabBrowserTabs = document?.querySelector(
      "#tabbrowser-tabs",
    ) as XULTabElement | null;

    createEffect(() => {
      const isEnable = config().tab.tabScroll.enabled;
      Services.prefs.setBoolPref("toolkit.tabbox.switchByScrolling", isEnable);
      if (!tabBrowserTabs) return;
      if (isEnable) {
        tabBrowserTabs.on_wheel = (event: WheelEvent) => {
          this.handleOnWheel(event, tabBrowserTabs);
        };
      } else if (
        Object.prototype.hasOwnProperty.call(tabBrowserTabs, "on_wheel")
      ) {
        delete tabBrowserTabs.on_wheel;
      }
    });
  }
}
