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
const GROUP_KINDS_PREF = "floorp.tabstacks.groupKinds";

/**
 * Every native tab group is presented as one of two kinds:
 * - "stack": Vivaldi-style two-level presentation (chip + stack bar) — the
 *   default for every group the user creates.
 * - "group": untouched native Firefox presentation (inline tabs, native
 *   label and collapse behavior).
 * Only explicit "group" choices are stored, keyed by the native group id
 * (session restore preserves those ids, so the choice survives restarts).
 * Stale ids of long-gone groups are harmless and tiny; they are dropped
 * whenever their group is toggled back to a stack.
 */
type GroupKind = "stack" | "group";

function readGroupKinds(): Record<string, GroupKind> {
  try {
    const raw = Services.prefs.getStringPref(GROUP_KINDS_PREF, "{}");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const kinds: Record<string, GroupKind> = {};
    for (const [id, kind] of Object.entries(parsed)) {
      if (kind === "group") kinds[id] = "group";
    }
    return kinds;
  } catch (e) {
    console.error("[tab-stacks] Failed to read group kinds pref:", e);
    return {};
  }
}

function getGroupKind(groupId: string): GroupKind {
  return readGroupKinds()[groupId] ?? "stack";
}

function setGroupKind(groupId: string, kind: GroupKind): void {
  try {
    const kinds = readGroupKinds();
    if (kind === "group") {
      kinds[groupId] = "group";
    } else {
      delete kinds[groupId];
    }
    Services.prefs.setStringPref(GROUP_KINDS_PREF, JSON.stringify(kinds));
  } catch (e) {
    console.error("[tab-stacks] Failed to save group kind:", e);
  }
}

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
 *
 * Groups come in two user-selectable kinds ("Turn into tab group/stack"
 * in the label context menu): stacks as above, or plain native groups
 * that keep Firefox's inline presentation. Split-view groups are always
 * left native regardless of kind.
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
    // Mount inside #navigator-toolbox, directly under the tab strip
    // (Vivaldi row order: tabs → stack bar → address bar). Living inside
    // the toolbox is safe for zen mode: it re-measures the toolbox height
    // right before every retract (zen-mode.tsx tryHideTop), so the bar
    // mounting/unmounting can no longer leave zen with a stale height.
    const toolbox = document.getElementById("navigator-toolbox");
    const navBar = document.getElementById("nav-bar");
    if (!gb || !toolbox || !navBar) {
      this.logger.warn("Browser chrome not ready; skipping tab stacks.");
      return;
    }

    render(StackStyleElement, document.head, {
      hotCtx: import.meta.hot,
    });
    render(StackBar, toolbox, {
      marker: navBar,
      hotCtx: import.meta.hot,
    });

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
      // Chip close button: closes the whole stack (all member tabs).
      const closeEl = target?.closest?.(".derp-stack-close");
      if (closeEl) {
        const group = closeEl.closest(
          "tab-group[data-derp-stack]",
        ) as StackGroup | null;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type !== "click" || !group) return;
        try {
          const gb = getGBrowser();
          if (gb?.removeTabs) {
            gb.removeTabs([...group.tabs]);
          } else {
            for (const t of [...group.tabs]) {
              getGBrowser()?.removeTab(t, { animate: false });
            }
          }
        } catch (e) {
          console.error("[tab-stacks] Failed to close stack:", e);
        }
        return;
      }
      const labelContainer = target?.closest?.(".tab-group-label-container");
      if (!labelContainer) return;
      // Only groups we own — split-view groups keep native label behavior.
      const group = labelContainer.closest(
        "tab-group[data-derp-stack]",
      ) as StackGroup | null;
      if (!group) return;
      // mousedown passes through untouched: the native group-label drag
      // (reordering the whole stack within the strip) starts there. Only
      // click is intercepted — that is where the native collapse toggle
      // lives and where our activate/edit behavior goes.
      if (event.type !== "click") return;
      event.preventDefault();
      event.stopImmediatePropagation();

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

    // Stack ⇄ plain-group conversion. This build wires no context menu to
    // group labels (no context= attribute on the label chain), so the
    // feature owns one: right-click on any group label/chip opens it.
    // Split-view groups are excluded — they keep native behavior wholesale.
    const KIND_MENU_ID = "derp-stack-kind-menu";
    const doc = document as Document & {
      createXULElement: (tag: string) => XULElement;
    };
    let menuGroup: StackGroup | null = null;
    let kindMenu:
      | (XULElement & {
        openPopupAtScreen: (x: number, y: number, isContext: boolean) => void;
      })
      | null = null;
    let kindItem: XULElement | null = null;
    const popupSet = doc.getElementById("mainPopupSet");
    if (popupSet) {
      kindMenu = doc.createXULElement("menupopup") as typeof kindMenu &
        XULElement;
      kindMenu.id = KIND_MENU_ID;
      kindItem = doc.createXULElement("menuitem");
      kindItem.addEventListener("command", () => {
        if (!menuGroup) return;
        const next: GroupKind = getGroupKind(menuGroup.id) === "stack"
          ? "group"
          : "stack";
        setGroupKind(menuGroup.id, next);
        this.updateGroupChips();
        syncActiveGroup();
        bumpStacksVersion();
      });
      kindMenu.appendChild(kindItem);
      popupSet.appendChild(kindMenu);
    }
    const onLabelContextMenu = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const labelContainer = target?.closest?.(".tab-group-label-container");
      const group = (labelContainer?.closest?.("tab-group") ??
        null) as StackGroup | null;
      if (!group || !kindMenu || !kindItem) return;
      if (this.isSplitViewGroup(group)) return;
      event.preventDefault();
      event.stopPropagation();
      menuGroup = group;
      kindItem.setAttribute(
        "label",
        getGroupKind(group.id) === "stack"
          ? "Turn into tab group"
          : "Turn into tab stack",
      );
      kindMenu.openPopupAtScreen(event.screenX, event.screenY, true);
    };
    addEventListener("contextmenu", onLabelContextMenu, true);
    onCleanup(() => {
      removeEventListener("contextmenu", onLabelContextMenu, true);
      kindMenu?.remove();
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
          group.querySelector(".derp-stack-close")?.remove();
          continue;
        }
        if (getGroupKind(group.id) === "group") {
          // Plain tab group by user choice: native presentation end to
          // end. All stack CSS/behavior is scoped to [data-derp-stack].
          group.removeAttribute("data-derp-stack");
          group.querySelector(".derp-stack-close")?.remove();
          continue;
        }
        group.setAttribute("data-derp-stack", "true");
        // Close button lives inside the label so it rides the chip's flex
        // row (order puts it after the count badge); shown on hover.
        const labelEl = group.querySelector(".tab-group-label");
        if (labelEl && !labelEl.querySelector(".derp-stack-close")) {
          const close = (document as Document & {
            createXULElement: (tag: string) => XULElement;
          }).createXULElement("image");
          close.classList.add("derp-stack-close");
          close.setAttribute("src", "chrome://global/skin/icons/close.svg");
          close.setAttribute("tooltiptext", "Close stack");
          labelEl.appendChild(close);
        }
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
