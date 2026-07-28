/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
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
  selectedBrowser?: { currentURI?: { spec?: string } };
  tabGroups: StackGroup[];
  selectedTab: StackTab;
  tabContainer: XULElement;
  tabGroupMenu?: { openEditModal: (group: StackGroup) => void };
  removeTab: (tab: StackTab, opts?: Record<string, unknown>) => void;
  removeTabs?: (tabs: StackTab[], opts?: Record<string, unknown>) => void;
  addTab: (url: string, opts: Record<string, unknown>) => StackTab;
  ungroupTab?: (tab: StackTab) => void;
  reloadTab?: (tab: StackTab) => void;
  moveTabBefore?: (tab: StackTab, target: StackTab) => void;
  moveTabAfter?: (tab: StackTab, target: StackTab) => void;
};

export const getGBrowser = (): TabBrowser | null =>
  (globalThis as unknown as { gBrowser?: TabBrowser }).gBrowser ?? null;

/** Bumped on any tab/group mutation so proxies re-read live tab state. */
const [version, setVersion] = createSignal(0);
export const bumpStacksVersion = () => setVersion((v) => v + 1);

const [activeGroup, setActiveGroup] = createSignal<StackGroup | null>(null);

/** The stack bar shows the group of the currently selected tab — but only
 * groups we own (marked data-bork-stack); split-view groups are not ours. */
export const syncActiveGroup = () => {
  const gb = getGBrowser();
  const group = gb?.selectedTab?.group ?? null;
  const isOurs = group &&
    (group as unknown as Element).getAttribute?.("data-bork-stack") ===
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

/** Title shown on an unnamed stack chip: its first REACHABLE tab, as a
 * stable anchor. It used to track the last tab clicked inside the stack,
 * which read as the chip constantly renaming itself while you worked in
 * it. Workspaces can park members hidden — never title the chip after a
 * tab this workspace cannot even see.
 * (A user-given name always wins over this — see updateGroupChips.) */
export const getGroupDisplayTitle = (group: StackGroup): string => {
  const anchor = group.tabs.find((t) => !(t as { hidden?: boolean }).hidden) ??
    group.tabs[0];
  const label = anchor?.label ?? "";
  // Bound the attribute size only — visually the chip's box crops and
  // fades the text like a tab, so the cut must stay past the widest chip.
  return label.length > 60 ? `${label.slice(0, 60)}…` : label;
};

export const activateGroup = (group: StackGroup) => {
  const gb = getGBrowser();
  if (!gb) return;
  const remembered = lastSelectedInGroup.get(group);
  const usable = (t: StackTab | undefined): t is StackTab =>
    !!t && t.isConnected && t.group === group &&
    !(t as { hidden?: boolean }).hidden;
  // Never select a workspace-hidden member — that yanks the session into
  // another workspace's state. First reachable tab is the fallback.
  const target = usable(remembered)
    ? remembered
    : group.tabs.find((t) => usable(t)) ?? null;
  if (target) {
    gb.selectedTab = target;
  }
};

const DEFAULT_FAVICON = "chrome://global/skin/icons/defaultFavicon.svg";

/**
 * Stable per-tab drag identity. NOT linkedPanel: that is null until a tab
 * has a browser attached (lazy/session-restored tabs), so a first drag of
 * an unloaded tab carried an empty id and the drop silently no-opped —
 * "only works the second try". Stamped on demand and good for the tab's
 * whole life.
 */
let dragIdCounter = 0;
export const getTabDragId = (tab: StackTab): string => {
  let id = tab.getAttribute("data-bork-tab-id");
  if (!id) {
    id = `dt${++dragIdCounter}`;
    tab.setAttribute("data-bork-tab-id", id);
  }
  return id;
};

export const findTabByDragId = (id: string): StackTab | undefined =>
  getGBrowser()?.tabs.find((t) => t.getAttribute("data-bork-tab-id") === id);

function StackTabProxy(props: { tab: StackTab }) {
  // Inline address edit: double-click widens the cell into a text input,
  // Enter navigates that tab, Escape/blur closes. Editing a tab in place
  // beats selecting it, reaching for the address bar and coming back.
  const [editing, setEditing] = createSignal(false);

  const currentUrl = (): string => {
    try {
      const b = props.tab.linkedBrowser as
        | { currentURI?: { spec?: string } }
        | undefined;
      const spec = b?.currentURI?.spec ?? "";
      return spec === "about:newtab" || spec === "about:blank" ? "" : spec;
    } catch {
      return "";
    }
  };

  const startEditing = () => {
    setEditing(true);
    // Focus once solid-xul has swapped the row for the input (the
    // universal renderer gives us no `ref` helper, hence the id lookup).
    setTimeout(() => {
      const input = document?.getElementById(
        `bork-stack-url-${getTabDragId(props.tab)}`,
      ) as HTMLInputElement | null;
      input?.focus();
      input?.select();
    }, 0);
  };

  const commit = (value: string) => {
    setEditing(false);
    const url = value.trim();
    if (!url) return;
    try {
      const uri = Services.uriFixup.getFixupURIInfo(
        url,
        Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP |
          Ci.nsIURIFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS,
      ).preferredURI;
      if (!uri) return;
      // Typed input must never run script or spoof a document.
      if (uri.schemeIs("javascript") || uri.schemeIs("data")) return;
      const b = props.tab.linkedBrowser as
        | { fixupAndLoadURIString?: (u: string, o: unknown) => void }
        | undefined;
      b?.fixupAndLoadURIString?.(uri.spec, {
        triggeringPrincipal: Services.scriptSecurityManager
          .getSystemPrincipal(),
      });
    } catch (e) {
      console.error("[tab-stacks] inline address load failed:", e);
    }
  };

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
      class="bork-stack-tab"
      align="center"
      data-selected={selected()}
      data-bork-drag-id={getTabDragId(props.tab)}
      context="tabContextMenu"
      draggable="true"
      onDragStart={(event: DragEvent) => {
        // Proxies drag with a private type: within the bar to reorder
        // the stack, up into the tab row to leave it (the real member
        // tabs are hidden in row 1, so this is the only drag handle).
        event.dataTransfer?.setData(
          "application/x-bork-stack-tab",
          getTabDragId(props.tab),
        );
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          try {
            const ghost = document!.createElement("div");
            ghost.className = "borkStackDragGhost";
            ghost.textContent = props.tab.label ?? "";
            document!.documentElement?.appendChild(ghost);
            event.dataTransfer.setDragImage(ghost, 12, 14);
            setTimeout(() => ghost.remove(), 0);
          } catch {
            // default drag image
          }
        }
      }}
      data-editing={editing() ? "true" : "false"}
      onClick={() => {
        if (editing()) return;
        const gb = getGBrowser();
        if (gb) {
          gb.selectedTab = props.tab;
        }
      }}
      onDblClick={(event: MouseEvent) => {
        event.stopPropagation();
        startEditing();
      }}
    >
      <Show
        when={!editing()}
        fallback={
          <input
            id={`bork-stack-url-${getTabDragId(props.tab)}`}
            class="bork-stack-url-input"
            value={currentUrl()}
            placeholder="Enter address"
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                commit((e.currentTarget as HTMLInputElement).value);
              } else if (e.key === "Escape") {
                setEditing(false);
              }
              // The strip's own key handling must not see this typing.
              e.stopPropagation();
            }}
            onBlur={() => setEditing(false)}
          />
        }
      >
        <xul:hbox class="bork-stack-tab-iconbox" align="center">
          <xul:image class="bork-stack-tab-icon" src={icon()} />
          <xul:toolbarbutton
            class="bork-stack-tab-close"
            tooltiptext="Close tab"
            onClick={(event: MouseEvent) => {
              event.stopPropagation();
              getGBrowser()?.removeTab(props.tab, { animate: false });
            }}
          />
        </xul:hbox>
        <xul:label class="bork-stack-tab-label" crop="end">
          {label()}
        </xul:label>
        <xul:image
          class="bork-stack-tab-refresh"
          src="chrome://global/skin/icons/reload.svg"
          tooltiptext="Reload tab"
          onMouseDown={(event: MouseEvent) => {
            event.stopPropagation();
            event.preventDefault();
          }}
          onClick={(event: MouseEvent) => {
            event.stopPropagation();
            getGBrowser()?.reloadTab?.(props.tab);
          }}
        />
      </Show>
    </xul:hbox>
  );
}

/** Pixels per frame while a scroll arrow is held down. */
const ARROW_STEP_PX = 14;
/** Only snap to a cell edge if one is already this close, so a release
 * never yanks the row somewhere the user did not aim it. */
const ARROW_SNAP_PX = 60;

function StackRow() {
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

  // Arrows and end-of-travel state, driven by the same three attributes row 1
  // uses ([overflowing] / [scrolledtostart] / [scrolledtoend]) so styles.css
  // can mirror tabs.css rule for rule.
  //
  // Scroll ownership: this row is overflow-x HIDDEN (styles.css says why:
  // hidden keeps the browser's wheel transaction from latching onto the row
  // and swallowing strip/page scrolling), so nothing scrolls it except the
  // wheel handler and the arrow hold-loop below. Deliberately NOT an
  // <arrowscrollbox>: that widget consumes wheel events it declined to act
  // on, and its click-to-scroll rAF loop has no exit condition — the hold
  // loop below has every exit the toolkit's lacks.
  onMount(() => {
    const row = document!.getElementById("bork-stack-bar");
    const scroller = document!.getElementById("bork-stack-scroller");
    const items = document!.getElementById("bork-stack-items");
    const up = document!.getElementById("bork-stack-scroll-up");
    const down = document!.getElementById("bork-stack-scroll-down");
    if (!row || !scroller || !items || !up || !down) return;

    // Write only on change: an unconditional write feeds the ResizeObserver
    // its own output, which is how widget code ends up in a style loop.
    const flag = (name: string, on: boolean) => {
      if (on !== row.hasAttribute(name)) row.toggleAttribute(name, on);
    };

    const sync = () => {
      const max = scroller.scrollWidth - scroller.clientWidth;
      const overflowing = max > 1;
      const pos = Math.abs(scroller.scrollLeft);
      flag("overflowing", overflowing);
      flag("scrolledtostart", !overflowing || pos <= 1);
      flag("scrolledtoend", !overflowing || pos >= max - 1);
    };

    // The arrows collapse out of flow when they are not needed, so showing
    // them narrows the scroller. That is bistable, not oscillating: hiding
    // widens the row and a row that already fits still fits.
    const overflowObserver = new ResizeObserver(sync);
    overflowObserver.observe(scroller);
    overflowObserver.observe(items);
    scroller.addEventListener("scroll", sync);
    sync();

    // The row's one wheel path. Same rule the tab strip's patched
    // arrowscrollbox uses: pixel-mode input (trackpads) scrolls only on its
    // horizontal-dominant events — a macOS momentum tail follows the lift
    // velocity, not the drag, so mapping vertical pixel deltas onto a
    // horizontal row lets the tail drag it back on its own. Line/page
    // devices (plain mouse wheels, no momentum machinery) keep the vertical
    // mapping so they can drive the row at all. Consume only what scrolled;
    // everything else falls through to the normal wheel path untouched.
    const onWheel = (event: WheelEvent) => {
      if (scroller.scrollWidth - scroller.clientWidth <= 1) return;
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
        if (!horizontal) return;
        scroller.scrollLeft += event.deltaX;
      } else {
        const delta = horizontal ? event.deltaX : event.deltaY;
        scroller.scrollLeft += delta * ARROW_STEP_PX;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    scroller.addEventListener("wheel", onWheel);

    let heldDir = 0;
    let frame = 0;

    const step = () => {
      frame = 0;
      if (!heldDir || !scroller.isConnected) return;
      scroller.scrollLeft += heldDir * ARROW_STEP_PX;
      frame = requestAnimationFrame(step);
    };

    // Release lands on a cell edge the way row 1's _stopScroll snaps by index,
    // so a tap leaves whole cells rather than a sliced one.
    const snapToCell = () => {
      const edge = scroller.getBoundingClientRect().left;
      let nearest = 0;
      let distance = Infinity;
      for (const cell of scroller.querySelectorAll(".bork-stack-tab")) {
        const delta = cell.getBoundingClientRect().left - edge;
        if (Math.abs(delta) < distance) {
          distance = Math.abs(delta);
          nearest = delta;
        }
      }
      if (distance < ARROW_SNAP_PX) scroller.scrollLeft += nearest;
    };

    const stopHold = () => {
      if (!heldDir) return;
      heldDir = 0;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      snapToCell();
    };

    const startHold = (dir: number) => (event: MouseEvent) => {
      if (event.button !== 0) return;
      // Keep focus where it was; the row is a pointer target, not a stop.
      event.preventDefault();
      heldDir = dir;
      if (!frame) frame = requestAnimationFrame(step);
    };

    const holdLeft = startHold(-1);
    const holdRight = startHold(1);
    up.addEventListener("mousedown", holdLeft);
    down.addEventListener("mousedown", holdRight);
    up.addEventListener("mouseleave", stopHold);
    down.addEventListener("mouseleave", stopHold);
    document!.addEventListener("mouseup", stopHold);
    window.addEventListener("blur", stopHold);

    onCleanup(() => {
      heldDir = 0;
      if (frame) cancelAnimationFrame(frame);
      overflowObserver.disconnect();
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("scroll", sync);
      up.removeEventListener("mousedown", holdLeft);
      down.removeEventListener("mousedown", holdRight);
      up.removeEventListener("mouseleave", stopHold);
      down.removeEventListener("mouseleave", stopHold);
      document!.removeEventListener("mouseup", stopHold);
      window.removeEventListener("blur", stopHold);
    });
  });

  return (
    <xul:hbox id="bork-stack-bar" align="center">
      <xul:toolbarbutton
        id="bork-stack-scroll-up"
        class="bork-stack-scrollbutton"
        tooltiptext="Scroll tabs left"
      />
      {/* overflow-x:hidden + one wheel handler (onWheel above) — the row is
          invisible to the browser's wheel-transaction machinery. */}
      <xul:hbox id="bork-stack-scroller">
        {/* Sized by its content, so the ResizeObserver above sees tabs come
            and go and labels change width. */}
        <xul:hbox id="bork-stack-items" align="center">
          <For each={tabs()}>{(tab) => <StackTabProxy tab={tab} />}</For>
        </xul:hbox>
      </xul:hbox>
      <xul:toolbarbutton
        id="bork-stack-scroll-down"
        class="bork-stack-scrollbutton"
        tooltiptext="Scroll tabs right"
      />
      {/* Outside the scroller and last in the row, which is where row 1 keeps
          the "+" it actually shows: #new-tab-button is a sibling AFTER
          #tabbrowser-tabs, so it sits past the right arrow and never scrolls
          away. (Row 1 also has #tabs-newtab-button inside the scroller, but
          that is the one it hides once the strip overflows.) */}
      <xul:toolbarbutton
        id="bork-stack-newtab"
        tooltiptext="New tab in stack"
        onClick={addTabToActiveGroup}
      />
    </xul:hbox>
  );
}

export function StackBar() {
  return (
    <Show when={activeGroup()}>
      <StackRow />
    </Show>
  );
}
