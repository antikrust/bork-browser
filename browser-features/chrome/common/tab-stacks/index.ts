/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { onCleanup } from "solid-js";
import { render } from "@nora/solid-xul";
import {
  noraComponent,
  NoraComponentBase,
} from "#features-chrome/utils/base.ts";
import {
  activateGroup,
  bumpStacksVersion,
  getGBrowser,
  getGroupDisplayTitle,
  rememberSelection,
  StackBar,
  type StackGroup,
  StackStyleElement,
  syncActiveGroup,
} from "./stack-bar.tsx";

const ENABLED_PREF = "floorp.tabstacks.enabled";

/** Every mutation that can change stack contents or chip labels. */
const TAB_EVENTS = [
  "TabSelect",
  "TabClose",
  "TabMove",
  "TabAttrModified",
  "TabGrouped",
  "TabUngrouped",
  "TabGroupCreate",
  "TabGroupRemoved",
  "TabGroupCollapse",
  "TabGroupExpand",
] as const;

/**
 * Vivaldi-style two-level tab stacks over Firefox's native tab groups.
 * The native group stays the data model (creation, persistence, session
 * restore); this feature only changes presentation: member tabs are hidden
 * from row 1 (the chip represents the stack) and the active group's tabs
 * render as proxies in a second bar under the tab strip.
 */
@noraComponent(import.meta.hot)
export default class TabStacks extends NoraComponentBase {
  init(): void {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }
    if (!Services.prefs.getBoolPref(ENABLED_PREF, true)) {
      // Fault-finding round (2026-07-16): off via override.ini; groups fall
      // back to native Firefox presentation. Set true to bring stacks back.
      this.logger.info("Tab stacks switched off (floorp.tabstacks.enabled=false)");
      return;
    }

    const gb = getGBrowser();
    // Mount OUTSIDE #navigator-toolbox: zen-mode animates the toolbox using
    // measured heights, and a bar that comes and goes inside it makes those
    // measurements stale (collapsed-layout bug). As a sibling below the
    // toolbox, the stack bar shares no geometry with zen's math.
    const toolbox = document.getElementById("navigator-toolbox");
    const parent = toolbox?.parentElement;
    if (!gb || !toolbox || !parent) {
      this.logger.warn("Browser chrome not ready; skipping tab stacks.");
      return;
    }

    render(StackStyleElement, document.head, {
      hotCtx: import.meta.hot,
    });
    const anchor = toolbox.nextElementSibling;
    if (anchor) {
      render(StackBar, parent, {
        marker: anchor,
        hotCtx: import.meta.hot,
      });
    } else {
      render(StackBar, parent, { hotCtx: import.meta.hot });
    }

    const onTabEvent = (event: Event) => {
      if (event.type === "TabSelect") {
        rememberSelection();
      }
      // Classify/mark groups first so syncActiveGroup sees fresh marks.
      this.updateGroupChips();
      syncActiveGroup();
      bumpStacksVersion();
    };
    for (const type of TAB_EVENTS) {
      addEventListener(type, onTabEvent);
    }
    onCleanup(() => {
      for (const type of TAB_EVENTS) {
        removeEventListener(type, onTabEvent);
      }
    });

    // Chip interactions (native behavior would toggle collapse, which
    // fights our always-expanded model): single click activates the stack,
    // double click opens the native group editor (rename + color).
    let pendingActivate: ReturnType<typeof setTimeout> | null = null;
    const onChipPress = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      const labelContainer = target?.closest?.(".tab-group-label-container");
      if (!labelContainer) return;
      // Only groups we own — split-view groups keep native label behavior.
      const group = labelContainer.closest(
        "tab-group[data-derp-stack]",
      ) as StackGroup | null;
      if (!group) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type !== "click") return;

      if (event.detail >= 2) {
        if (pendingActivate) {
          clearTimeout(pendingActivate);
          pendingActivate = null;
        }
        try {
          getGBrowser()?.tabGroupMenu?.openEditModal(group);
        } catch (e) {
          console.error("[tab-stacks] Failed to open group editor:", e);
        }
        return;
      }

      if (pendingActivate) clearTimeout(pendingActivate);
      pendingActivate = setTimeout(() => {
        pendingActivate = null;
        activateGroup(group);
        this.updateGroupChips();
        syncActiveGroup();
        bumpStacksVersion();
      }, 230);
    };
    addEventListener("mousedown", onChipPress, true);
    addEventListener("click", onChipPress, true);
    onCleanup(() => {
      if (pendingActivate) clearTimeout(pendingActivate);
      removeEventListener("mousedown", onChipPress, true);
      removeEventListener("click", onChipPress, true);
    });

    // Some group events don't bubble reliably; a debounced observer on the
    // tab strip catches every structural change (group created, tab joins,
    // titles) regardless of event plumbing.
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        rememberSelection();
        syncActiveGroup();
        bumpStacksVersion();
        this.updateGroupChips();
      }, 80);
    };
    const observer = new MutationObserver(scheduleRefresh);
    observer.observe(gb.tabContainer as unknown as Node, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["label", "selected", "image"],
    });
    onCleanup(() => {
      observer.disconnect();
      if (refreshTimer) clearTimeout(refreshTimer);
    });

    rememberSelection();
    this.updateGroupChips();
    syncActiveGroup();
    bumpStacksVersion();
    this.logger.info("Tab stacks initialized");
  }


  /**
   * Classify groups and keep chips informative. Only groups we MARK with
   * data-derp-stack get stack behavior (CSS hiding, forced expansion, chip
   * click handling). Split-view binds its panes with tab groups too — those
   * must be left completely alone or the two features fight (runaway
   * revive/expand loop, mangled tabs, eventual crash).
   */
  private isSplitViewGroup(group: StackGroup): boolean {
    try {
      return group.tabs.some(
        (t) =>
          t.hasAttribute("floorpSplitViewGroupId") ||
          t.hasAttribute("split-view-layout"),
      );
    } catch {
      // When unsure, hands off.
      return true;
    }
  }

  private updateGroupChips(): void {
    const gb = getGBrowser();
    if (!gb) return;
    for (const group of gb.tabGroups) {
      try {
        if (this.isSplitViewGroup(group)) {
          group.removeAttribute("data-derp-stack");
          continue;
        }
        group.setAttribute("data-derp-stack", "true");
        if (group.collapsed) {
          group.collapsed = false;
        }
        const label = group.querySelector(".tab-group-label");
        label?.setAttribute("data-derp-count", String(group.tabs.length));
        // A user-given group name wins; otherwise show the stack's
        // current tab title.
        label?.setAttribute(
          "data-derp-title",
          group.label || getGroupDisplayTitle(group),
        );
      } catch {
        // Group may be mid-removal; the next event refreshes it.
      }
    }
  }
}
