/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo, createSignal, For, Show } from "solid-js";
import styles from "./styles.css?inline";

export function StackStyleElement() {
  return <style>{styles}</style>;
}

export type StackTab = XULElement & {
  label: string;
  selected: boolean;
  linkedPanel: string;
  group: StackGroup | null;
};

export type StackGroup = XULElement & {
  id: string;
  label: string;
  collapsed: boolean;
  tabs: StackTab[];
  addTabs: (tabs: StackTab[]) => void;
};

type TabBrowser = {
  tabs: StackTab[];
  tabGroups: StackGroup[];
  selectedTab: StackTab;
  tabContainer: XULElement;
  tabGroupMenu?: { openEditModal: (group: StackGroup) => void };
  removeTab: (tab: StackTab, opts?: Record<string, unknown>) => void;
  removeTabs?: (tabs: StackTab[], opts?: Record<string, unknown>) => void;
  addTab: (url: string, opts: Record<string, unknown>) => StackTab;
  ungroupTab?: (tab: StackTab) => void;
  moveTabBefore?: (tab: StackTab, target: StackTab) => void;
};

export const getGBrowser = (): TabBrowser | null =>
  (globalThis as unknown as { gBrowser?: TabBrowser }).gBrowser ?? null;

/** Bumped on any tab/group mutation so proxies re-read live tab state. */
const [version, setVersion] = createSignal(0);
export const bumpStacksVersion = () => setVersion((v) => v + 1);

const [activeGroup, setActiveGroup] = createSignal<StackGroup | null>(null);

/** The stack bar shows the group of the currently selected tab — but only
 * groups we own (marked data-derp-stack); split-view groups are not ours. */
export const syncActiveGroup = () => {
  const gb = getGBrowser();
  const group = gb?.selectedTab?.group ?? null;
  const isOurs = group &&
    (group as unknown as Element).getAttribute?.("data-derp-stack") ===
      "true";
  setActiveGroup(isOurs ? group : null);
};

/** Remember the last selected tab per group so chip clicks feel right. */
const lastSelectedInGroup = new WeakMap<StackGroup, StackTab>();

export const rememberSelection = () => {
  const gb = getGBrowser();
  const tab = gb?.selectedTab;
  const group = tab?.group;
  if (tab && group) {
    lastSelectedInGroup.set(group, tab);
  }
};

/** Title shown on the stack chip: the stack's current tab, like Vivaldi. */
export const getGroupDisplayTitle = (group: StackGroup): string => {
  const remembered = lastSelectedInGroup.get(group);
  const tab =
    remembered && remembered.isConnected && remembered.group === group
      ? remembered
      : group.tabs.find((t) => t.selected) ?? group.tabs[0];
  const label = tab?.label ?? "";
  return label.length > 24 ? `${label.slice(0, 24)}…` : label;
};

export const activateGroup = (group: StackGroup) => {
  const gb = getGBrowser();
  if (!gb) return;
  const remembered = lastSelectedInGroup.get(group);
  const target =
    remembered && remembered.isConnected && remembered.group === group
      ? remembered
      : group.tabs[0];
  if (target) {
    gb.selectedTab = target;
  }
};

const DEFAULT_FAVICON = "chrome://global/skin/icons/defaultFavicon.svg";

function StackTabProxy(props: { tab: StackTab }) {
  const label = () => {
    version();
    return props.tab.label;
  };
  const icon = () => {
    version();
    return props.tab.getAttribute("image") || DEFAULT_FAVICON;
  };
  const selected = () => {
    version();
    return props.tab.selected ? "true" : "false";
  };

  return (
    <xul:hbox
      class="derp-stack-tab"
      align="center"
      data-selected={selected()}
      data-derp-panel={props.tab.linkedPanel ?? ""}
      draggable="true"
      onDragStart={(event: DragEvent) => {
        // Proxies drag with a private type: within the bar to reorder
        // the stack, up into the tab row to leave it (the real member
        // tabs are hidden in row 1, so this is the only drag handle).
        event.dataTransfer?.setData(
          "application/x-derp-stack-tab",
          // Null for lazy tabs (no browser yet); the drop handler treats
          // an empty panel id as a no-op.
          props.tab.linkedPanel ?? "",
        );
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          try {
            const ghost = document!.createElement("div");
            ghost.className = "derpStackDragGhost";
            ghost.textContent = props.tab.label ?? "";
            document!.documentElement?.appendChild(ghost);
            event.dataTransfer.setDragImage(ghost, 12, 14);
            setTimeout(() => ghost.remove(), 0);
          } catch {
            // default drag image
          }
        }
      }}
      onClick={() => {
        const gb = getGBrowser();
        if (gb) {
          gb.selectedTab = props.tab;
        }
      }}
    >
      <xul:hbox class="derp-stack-tab-iconbox" align="center">
        <xul:image class="derp-stack-tab-icon" src={icon()} />
        <xul:toolbarbutton
          class="derp-stack-tab-close"
          tooltiptext="Close tab"
          onClick={(event: MouseEvent) => {
            event.stopPropagation();
            getGBrowser()?.removeTab(props.tab, { animate: false });
          }}
        />
      </xul:hbox>
      <xul:label class="derp-stack-tab-label" crop="end">
        {label()}
      </xul:label>
    </xul:hbox>
  );
}

export function StackBar() {
  const tabs = createMemo(() => {
    version();
    const group = activeGroup();
    return group ? [...group.tabs] : [];
  });

  const addTabToActiveGroup = () => {
    const gb = getGBrowser();
    const group = activeGroup();
    if (!gb || !group) return;
    try {
      const newTabUrl =
        (globalThis as unknown as { BROWSER_NEW_TAB_URL?: string })
          .BROWSER_NEW_TAB_URL ?? "about:newtab";
      const tab = gb.addTab(newTabUrl, {
        triggeringPrincipal: Services.scriptSecurityManager
          .getSystemPrincipal(),
        skipAnimation: true,
      });
      group.addTabs([tab]);
      gb.selectedTab = tab;
    } catch (e) {
      console.error("[tab-stacks] Failed to add tab to group:", e);
    }
  };

  return (
    <Show when={activeGroup()}>
      {/* arrowscrollbox: one row forever — overflow scrolls behind arrow
          buttons exactly like the tab strip, instead of wrapping into a
          second row and growing the bar. */}
      <xul:arrowscrollbox
        id="derp-stack-bar"
        orient="horizontal"
        clicktoscroll="true"
        align="center"
      >
        <For each={tabs()}>{(tab) => <StackTabProxy tab={tab} />}</For>
        <xul:toolbarbutton
          id="derp-stack-newtab"
          label="+"
          tooltiptext="New tab in stack"
          onClick={addTabToActiveGroup}
        />
      </xul:arrowscrollbox>
    </Show>
  );
}
