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
  findTabByDragId,
  getGBrowser,
  getGroupDisplayTitle,
  rememberSelection,
  StackBar,
  type StackGroup,
  type StackTab,
  StackStyleElement,
  syncActiveGroup,
} from "./stack-bar.tsx";

const ENABLED_PREF = "floorp.tabstacks.enabled";

/** Stacked-layers glyph: a chip's "favicon" at rest, so chips swap
 * icon -> X on hover exactly like tabs do (they have no favicon of their
 * own — the stack is many tabs, not one). */
const STACK_ICON = `data:image/svg+xml;utf8,${
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="context-stroke" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg>',
  )
}`;
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
      // While a drag is in flight the bar must not unmount: pressing a
      // top-row tab selects it on mousedown, and if that tore the bar
      // down there would be nothing left to drop into. Reconciled at
      // drag end.
      if (!tabDragActive) syncActiveGroup();
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
        // Second click of a double: the first already activated the
        // stack (harmless), this one opens the editor.
        try {
          getGBrowser()?.tabGroupMenu?.openEditModal(group);
        } catch (e) {
          console.error("[tab-stacks] Failed to open group editor:", e);
        }
        return;
      }

      // Immediate: the old 230ms double-click disambiguation timer made
      // every stack switch feel laggy.
      activateGroup(group);
      this.updateGroupChips();
      syncActiveGroup();
      bumpStacksVersion();
    };
    addEventListener("mousedown", onChipPress, true);
    addEventListener("click", onChipPress, true);
    onCleanup(() => {
      removeEventListener("mousedown", onChipPress, true);
      removeEventListener("click", onChipPress, true);
    });

    // Row-2 proxies use the *native* tab context menu (reload, duplicate,
    // pin, close, move to…) rather than a parallel one. Firefox resolves
    // which tab the menu acts on as
    //   triggerNode.tab || triggerNode.closest("tab") || selectedTab
    // — so stamping `.tab` on the trigger node is the supported hook. It
    // must land before TabContextMenu.updateContextMenu reads it, hence
    // the capture-phase listener on document: capture runs before the
    // popup's own target-phase handler. Without this the menu would
    // silently act on the *selected* tab instead of the one clicked.
    const onTabContextShowing = (event: Event) => {
      const popup = event.target as Element & { triggerNode?: Node | null };
      if (!(popup instanceof Element) || popup.id !== "tabContextMenu") return;
      const trigger = popup.triggerNode as
        | (Element & { tab?: StackTab | null })
        | null;
      const proxy = trigger?.closest?.(".derp-stack-tab");
      if (!trigger || !proxy) return;
      const tab = findTabByDragId(
        proxy.getAttribute("data-derp-drag-id") ?? "",
      );
      if (tab) trigger.tab = tab;
    };
    const onTabContextHidden = (event: Event) => {
      const popup = event.target as Element & { triggerNode?: Node | null };
      if (!(popup instanceof Element) || popup.id !== "tabContextMenu") return;
      const trigger = popup.triggerNode as
        | (Element & { tab?: StackTab | null })
        | null;
      // Don't leave a tab reference on the node once the menu is gone.
      if (trigger && trigger.closest?.(".derp-stack-tab")) trigger.tab = null;
    };
    document.addEventListener("popupshowing", onTabContextShowing, true);
    document.addEventListener("popuphidden", onTabContextHidden, true);
    onCleanup(() => {
      document?.removeEventListener("popupshowing", onTabContextShowing, true);
      document?.removeEventListener("popuphidden", onTabContextHidden, true);
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

    // A tab dragged PAST a stack chip must reorder, not join: the
    // collapsed member tabs cluster at the chip's edge with zero width,
    // so the native drop math counts the whole neighbourhood as "inside
    // the group". Joining a stack deliberately stays possible by
    // dropping ON the chip itself. Detection is post-hoc: if a TabGrouped
    // lands on one of our stacks while a tab drag is in flight and the
    // drop point was not on the chip, the tab is moved back out to the
    // side of the stack it was dropped on.
    let tabDragActive = false;
    let lastDropPoint: { x: number; y: number } | null = null;
    const onTabDragStart = (event: DragEvent) => {
      const t = event.target as Element | null;
      if (
        t?.closest?.(".tabbrowser-tab") || t?.closest?.(".derp-stack-tab")
      ) {
        tabDragActive = true;
      }
    };
    const onAnyDrop = (event: DragEvent) => {
      if (tabDragActive) {
        lastDropPoint = { x: event.clientX, y: event.clientY };
      }
    };
    const endTabDrag = () => {
      clearDropIndicators();
      // TabGrouped from a drop arrives before dragend; clear on a delay,
      // then reconcile the bar with wherever selection actually landed.
      setTimeout(() => {
        tabDragActive = false;
        lastDropPoint = null;
        this.updateGroupChips();
        syncActiveGroup();
        bumpStacksVersion();
      }, 150);
    };
    const onTabGroupedDuringDrag = (event: Event) => {
      if (!tabDragActive || !lastDropPoint) return;
      const tab = event.target as StackTab;
      const group = tab.group;
      if (
        !group ||
        (group as unknown as Element).getAttribute?.("data-derp-stack") !==
          "true"
      ) {
        return;
      }
      const lc = (group as unknown as Element).querySelector(
        ".tab-group-label-container",
      );
      if (!lc) return;
      const r = lc.getBoundingClientRect();
      const p = lastDropPoint;
      const onChip = p.x >= r.x && p.x <= r.x + r.width &&
        p.y >= r.y && p.y <= r.y + r.height;
      if (onChip) return;
      try {
        const gb = getGBrowser();
        // Out of the group, landing right after it; left-side drops then
        // hop before it.
        gb?.ungroupTab?.(tab);
        if (p.x < r.x) {
          gb?.moveTabBefore?.(tab, group as unknown as StackTab);
        }
      } catch (e) {
        console.error("[tab-stacks] drop-outside eject failed:", e);
      }
    };
    // Deliberate join: dropping a row-1 tab ON the chip adds it to the
    // stack. With the member tabs zero-width, the native drop math almost
    // never resolves to "join" by itself, so the chip performs it.
    const PROXY_TYPE = "application/x-derp-stack-tab";
    const onChipDrop = (event: DragEvent) => {
      if (event.dataTransfer?.types?.includes(PROXY_TYPE)) return;
      const target = event.target as Element | null;
      const lc = target?.closest?.(".tab-group-label-container");
      const group = (lc?.closest?.("tab-group[data-derp-stack]") ??
        null) as StackGroup | null;
      if (!group) return;
      const dt = event.dataTransfer as
        | (DataTransfer & { mozSourceNode?: Node | null })
        | null;
      const src = ((dt?.mozSourceNode as Element | null)?.closest?.(
        ".tabbrowser-tab",
      ) ?? null) as StackTab | null;
      if (!src || src.group === group) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      clearDropIndicators();
      // Adopt after the native drag machinery settles.
      setTimeout(() => {
        try {
          group.addTabs([src]);
          this.updateGroupChips();
          syncActiveGroup();
          bumpStacksVersion();
          // A busy bar scrolls the newcomer into view.
          this.scrollProxyIntoView(src);
        } catch (e) {
          console.error("[tab-stacks] chip drop join failed:", e);
        }
      }, 0);
    };

    // Proxy drops: reorder inside the bar, or leave the stack by dropping
    // into the tab row.

    const clearDropIndicators = () => {
      for (
        const el of document.querySelectorAll("[data-drop-side]")
      ) {
        el.removeAttribute("data-drop-side");
      }
    };
    const onProxyDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types?.includes(PROXY_TYPE)) return;
      const t = event.target as Element | null;
      const inBar = t?.closest?.("#derp-stack-bar");
      const inStrip = t?.closest?.("#tabbrowser-tabs");
      if (!inBar && !inStrip) {
        clearDropIndicators();
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      // Insertion indicator on the nearest cell edge, like the top row.
      clearDropIndicators();
      if (inBar) {
        const proxies = [...inBar.querySelectorAll(".derp-stack-tab")];
        for (const proxy of proxies) {
          const r = proxy.getBoundingClientRect();
          if (event.clientX < r.x + r.width / 2) {
            proxy.setAttribute("data-drop-side", "before");
            return;
          }
        }
        proxies[proxies.length - 1]?.setAttribute("data-drop-side", "after");
      } else if (inStrip) {
        const gb = getGBrowser();
        if (!gb) return;
        let anchor: StackTab | undefined;
        for (const tab of gb.tabs) {
          if (tab.hidden || tab.group) continue;
          const r = tab.getBoundingClientRect();
          if (r.width === 0) continue;
          if (event.clientX >= r.x + r.width / 2) anchor = tab;
        }
        if (anchor) {
          (anchor as unknown as Element).setAttribute(
            "data-drop-side",
            "after",
          );
        } else {
          const first = gb.tabs.find(
            (tab) =>
              !tab.hidden && !tab.group &&
              tab.getBoundingClientRect().width > 0,
          );
          (first as unknown as Element | undefined)?.setAttribute(
            "data-drop-side",
            "before",
          );
        }
      }
    };
    const onProxyDrop = (event: DragEvent) => {
      clearDropIndicators();
      const dragId = event.dataTransfer?.getData(PROXY_TYPE);
      if (!dragId) return;
      const gb = getGBrowser();
      const tab = findTabByDragId(dragId);
      if (!gb || !tab) return;
      const target = event.target as Element | null;
      event.preventDefault();
      event.stopImmediatePropagation();
      try {
        const inBar = target?.closest?.("#derp-stack-bar");
        if (inBar) {
          // Reorder within the stack: place before the first proxy whose
          // midpoint lies right of the drop.
          const bar = inBar as Element;
          const proxies = [...bar.querySelectorAll(".derp-stack-tab")];
          let placed = false;
          for (const proxy of proxies) {
            const r = proxy.getBoundingClientRect();
            if (event.clientX < r.x + r.width / 2) {
              const other = findTabByDragId(
                proxy.getAttribute("data-derp-drag-id") ?? "",
              );
              if (other && other !== tab) {
                gb.moveTabBefore?.(tab, other);
              }
              placed = true;
              break;
            }
          }
          if (!placed) {
            const last = proxies[proxies.length - 1];
            const other = findTabByDragId(
              last?.getAttribute("data-derp-drag-id") ?? "",
            );
            if (other && other !== tab) gb.moveTabAfter?.(tab, other);
          }
        } else if (target?.closest?.("#tabbrowser-tabs")) {
          // Dropping onto its own chip is a no-op, not an exit.
          const ownChip = target?.closest?.("tab-group[data-derp-stack]");
          if (ownChip && ownChip === (tab.group as unknown as Element)) {
            return;
          }
          // Resolve the drop target from CURRENT geometry, before any
          // mutation: ungroupTab() inserts the tab into the strip and
          // shifts every tab right of the group, so measuring afterwards
          // resolved against moved boxes and landed a slot early.
          const visible = gb.tabs.filter(
            (t) =>
              !t.hidden && t !== tab && !t.group &&
              t.getBoundingClientRect().width > 0,
          );
          let anchor: StackTab | undefined;
          for (const t of visible) {
            const rect = t.getBoundingClientRect();
            if (event.clientX >= rect.x + rect.width / 2) anchor = t;
          }
          const first = visible[0];
          gb.ungroupTab?.(tab);
          if (anchor) {
            gb.moveTabAfter?.(tab, anchor);
          } else if (first) {
            gb.moveTabBefore?.(tab, first);
          }
        }
        this.updateGroupChips();
        syncActiveGroup();
        bumpStacksVersion();
        this.scrollProxyIntoView(tab);
      } catch (e) {
        console.error("[tab-stacks] proxy drop failed:", e);
      }
    };

    addEventListener("dragstart", onTabDragStart, true);
    addEventListener("drop", onAnyDrop, true);
    addEventListener("drop", onChipDrop, true);
    addEventListener("drop", onProxyDrop, true);
    addEventListener("dragover", onProxyDragOver, true);
    addEventListener("dragend", endTabDrag, true);
    addEventListener("TabGrouped", onTabGroupedDuringDrag);
    onCleanup(() => {
      removeEventListener("dragstart", onTabDragStart, true);
      removeEventListener("drop", onAnyDrop, true);
      removeEventListener("drop", onChipDrop, true);
      removeEventListener("drop", onProxyDrop, true);
      removeEventListener("dragover", onProxyDragOver, true);
      removeEventListener("dragend", endTabDrag, true);
      removeEventListener("TabGrouped", onTabGroupedDuringDrag);
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
  /** Scroll the bar so a just-moved tab's proxy is visible. */
  private scrollProxyIntoView(tab: { linkedPanel: string | null }): void {
    setTimeout(() => {
      try {
        const panel = tab.linkedPanel;
        if (!panel) return;
        const bar = document?.getElementById("derp-stack-bar") as
          | (Element & { ensureElementIsVisible?: (el: Element) => void })
          | null;
        const proxy = bar?.querySelector(
          `[data-derp-panel="${panel}"]`,
        );
        if (bar?.ensureElementIsVisible && proxy) {
          bar.ensureElementIsVisible(proxy);
        }
      } catch {
        // scroll is best-effort
      }
    }, 50);
  }

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
          group.querySelector(".derp-stack-icon")?.remove();
          for (
            const sel of [
              ".tab-group-label-container",
              ".tab-group-label-hover-highlight",
            ]
          ) {
            group.querySelector(sel)?.setAttribute("pack", "center");
          }
          continue;
        }
        if (getGroupKind(group.id) === "group") {
          // Plain tab group by user choice: native presentation end to
          // end. All stack CSS/behavior is scoped to [data-derp-stack].
          group.removeAttribute("data-derp-stack");
          group.querySelector(".derp-stack-close")?.remove();
          group.querySelector(".derp-stack-icon")?.remove();
          for (
            const sel of [
              ".tab-group-label-container",
              ".tab-group-label-hover-highlight",
            ]
          ) {
            group.querySelector(sel)?.setAttribute("pack", "center");
          }
          continue;
        }
        group.setAttribute("data-derp-stack", "true");
        // pack="center" is a XUL layout attribute mapped to
        // justify-content: center as a presentation hint — author CSS
        // cannot beat it at any specificity, not even inline !important.
        // It centred the chip in the 2px-taller row, leaving it 1px below
        // the tab selection boxes. The attribute is the only lever.
        for (
          const sel of [
            ".tab-group-label-container",
            ".tab-group-label-hover-highlight",
          ]
        ) {
          group.querySelector(sel)?.setAttribute("pack", "start");
        }
        // Close button lives inside the label so it rides the chip's flex
        // row (order puts it after the count badge); shown on hover.
        const labelEl = group.querySelector(".tab-group-label");
        const makeImage = (): XULElement =>
          (document as Document & {
            createXULElement: (tag: string) => XULElement;
          }).createXULElement("image");
        if (labelEl && !labelEl.querySelector(".derp-stack-icon")) {
          const icon = makeImage();
          icon.classList.add("derp-stack-icon");
          icon.setAttribute("src", STACK_ICON);
          labelEl.appendChild(icon);
        }
        if (labelEl && !labelEl.querySelector(".derp-stack-close")) {
          const close = makeImage();
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
