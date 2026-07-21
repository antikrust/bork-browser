/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  noraComponent,
  NoraComponentBase,
} from "#features-chrome/utils/base.ts";
import { configStore, setConfigStore } from "../workspaces/data/config.ts";
import { togglePanelSidebar } from "../lean-urlbar/sidebar-toggle.ts";

const { CustomizableUI } = ChromeUtils.importESModule(
  "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
);

/**
 * The two definite sidebar toggles in the navbar, replacing Firefox's own
 * #sidebar-button:
 *
 * - derp-workspaces-rail-button (far left): toggles the workspaces rail
 *   in Firefox's revamped-sidebar slot by flipping
 *   configStore.manageOnBms (workspaces/toolbar/workspaces-rail.tsx
 *   reacts to it).
 * - derp-panel-sidebar-button (far right): toggles the right panel
 *   sidebar through exactly the Cmd+Alt+S mechanism
 *   (lean-urlbar/sidebar-toggle.ts — derp-sidebar-hidden root attribute
 *   plus the derp.sidebar.hidden pref).
 *
 * CustomizableUI widgets are global singletons that outlive the window
 * that created them, while the feature layer (and its stores) is
 * per-window. The onCommand handlers therefore never close over module
 * state: they resolve the clicked window from the event and call the
 * window-local hooks each window registers on itself in init().
 */

const RAIL_BUTTON_ID = "derp-workspaces-rail-button";
const PANEL_BUTTON_ID = "derp-panel-sidebar-button";
const RAIL_BUTTON_TOOLTIP = "Workspaces sidebar";
const PANEL_BUTTON_TOOLTIP = "Panel sidebar";
const HOOKS_PROP = "gDerpPanelToggles";
const STYLE_ID = "derp-panel-toggles-style";

type PanelToggleHooks = {
  toggleWorkspacesRail: () => void;
  togglePanelSidebar: () => void;
};

/* 16x16 sidebar glyphs (fill="context-fill"): a rounded window outline
   with the left third filled, and its mirror with the right third
   filled. */
const LEFT_PANEL_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDE2IDE2IiBmaWxsPSJjb250ZXh0LWZpbGwiIGZpbGwtb3BhY2l0eT0iY29udGV4dC1maWxsLW9wYWNpdHkiPjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgZD0iTTMgMmgxMGEyIDIgMCAwIDEgMiAydjhhMiAyIDAgMCAxLTIgMkgzYTIgMiAwIDAgMS0yLTJWNGEyIDIgMCAwIDEgMi0yWm0zIDEuMjVoN2EuNzUgLjc1IDAgMCAxIC43NSAuNzV2OGEuNzUgLjc1IDAgMCAxLS43NSAuNzVINloiLz48L3N2Zz4=";
const RIGHT_PANEL_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDE2IDE2IiBmaWxsPSJjb250ZXh0LWZpbGwiIGZpbGwtb3BhY2l0eT0iY29udGV4dC1maWxsLW9wYWNpdHkiPjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgdHJhbnNmb3JtPSJtYXRyaXgoLTEgMCAwIDEgMTYgMCkiIGQ9Ik0zIDJoMTBhMiAyIDAgMCAxIDIgMnY4YTIgMiAwIDAgMS0yIDJIM2EyIDIgMCAwIDEtMi0yVjRhMiAyIDAgMCAxIDItMlptMyAxLjI1aDdhLjc1IC43NSAwIDAgMSAuNzUgLjc1djhhLjc1IC43NSAwIDAgMS0uNzUgLjc1SDZaIi8+PC9zdmc+";

const STYLE_TEXT = `
/* Firefox's native sidebar toggle is replaced by the derp pair; the
   widget is also removed from the navbar via CustomizableUI. */
#sidebar-button {
  display: none !important;
}

#${RAIL_BUTTON_ID} {
  list-style-image: url("${LEFT_PANEL_ICON}");
}

#${PANEL_BUTTON_ID} {
  list-style-image: url("${RIGHT_PANEL_ICON}");
}

#${RAIL_BUTTON_ID} .toolbarbutton-icon,
#${PANEL_BUTTON_ID} .toolbarbutton-icon {
  -moz-context-properties: fill, fill-opacity;
  fill: currentColor;
}
`;

/** Resolve the clicked window's hooks — never module state (see above). */
const resolveHooks = (event: Event): PanelToggleHooks | null => {
  const target = event.target as
    | (EventTarget & { ownerGlobal?: unknown })
    | null;
  const win = target?.ownerGlobal as
    | Record<string, unknown>
    | null
    | undefined;
  const hooks = win?.[HOOKS_PROP];
  return (hooks as PanelToggleHooks | undefined) ?? null;
};

const createToggleWidget = (
  id: string,
  tooltip: string,
  onCommand: (event: Event) => void,
): void => {
  try {
    const existing = CustomizableUI.getWidget(id);
    if (existing && existing.type !== "custom") {
      // Already provided by the API (an earlier window created it).
      return;
    }
    CustomizableUI.createWidget({
      id,
      type: "button",
      label: tooltip,
      tooltiptext: tooltip,
      removable: true,
      onCommand,
    });
  } catch (e) {
    console.error(`[panel-toggles] Failed to create widget ${id}:`, e);
  }
};

/**
 * Definite placement, same pattern as the workspaces chooser button:
 * re-pin on every window open if customization state drifted.
 * position 0 pins to the start; "end" pins to the last slot.
 */
const pinPlacement = (id: string, position: number | "end"): void => {
  try {
    const navbar = CustomizableUI.AREA_NAVBAR as string;
    const placement = CustomizableUI.getPlacementOfWidget(id) as
      | { area: string; position: number }
      | null;
    if (position === "end") {
      const ids = CustomizableUI.getWidgetIdsInArea(navbar) as string[];
      const isLast = placement?.area === navbar &&
        ids.length > 0 &&
        ids[ids.length - 1] === id;
      if (!isLast) {
        CustomizableUI.addWidgetToArea(id, navbar);
      }
      return;
    }
    if (
      !placement ||
      placement.area !== navbar ||
      placement.position !== position
    ) {
      CustomizableUI.addWidgetToArea(id, navbar, position);
    }
  } catch (e) {
    console.error(`[panel-toggles] Failed to place widget ${id}:`, e);
  }
};

const ensureWidgets = (): void => {
  // Firefox's own sidebar toggle makes way for the pair.
  try {
    CustomizableUI.removeWidgetFromArea("sidebar-button");
  } catch (e) {
    console.error("[panel-toggles] Failed to remove #sidebar-button:", e);
  }

  createToggleWidget(
    RAIL_BUTTON_ID,
    RAIL_BUTTON_TOOLTIP,
    (event) => resolveHooks(event)?.toggleWorkspacesRail(),
  );
  createToggleWidget(
    PANEL_BUTTON_ID,
    PANEL_BUTTON_TOOLTIP,
    (event) => resolveHooks(event)?.togglePanelSidebar(),
  );

  pinPlacement(RAIL_BUTTON_ID, 0);
  pinPlacement(PANEL_BUTTON_ID, "end");
};

@noraComponent(import.meta.hot)
export default class PanelToggles extends NoraComponentBase {
  init(): void {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }
    const root = document.documentElement;
    if (!root) return;

    // Main browser windows only (same guard as lean-urlbar): popup
    // windows show minimal chrome and have no navbar to toggle from.
    if (
      root.getAttribute("windowtype") !== "navigator:browser" ||
      (root.getAttribute("chromehidden") ?? "") !== ""
    ) {
      return;
    }

    // Window-local hooks for the global widget handlers. Each window
    // registers its own module instances so a toggle always acts on the
    // window that was clicked (and never on a closed window's stores).
    const hooks: PanelToggleHooks = {
      toggleWorkspacesRail: () =>
        setConfigStore("manageOnBms", !configStore.manageOnBms),
      togglePanelSidebar: () => togglePanelSidebar(window),
    };
    (window as unknown as Record<string, unknown>)[HOOKS_PROP] = hooks;

    this.injectStyle();
    ensureWidgets();

    this.logger.info("PanelToggles initialized");
  }

  private injectStyle(): void {
    if (document?.getElementById(STYLE_ID)) {
      return;
    }
    const style = document?.createElement("style");
    if (!style) {
      return;
    }
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    document?.head?.appendChild(style);
  }
}
