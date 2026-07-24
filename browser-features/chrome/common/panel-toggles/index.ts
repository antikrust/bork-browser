/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  noraComponent,
  NoraComponentBase,
} from "#features-chrome/utils/base.ts";
import { onCleanup } from "solid-js";
import { toggleRailInThisWindow } from "../workspaces/toolbar/workspaces-rail.tsx";
import { togglePanelSidebar } from "../lean-urlbar/sidebar-toggle.ts";
import { gestureActions } from "../mouse-gesture/utils/gestures.ts";

const { CustomizableUI } = ChromeUtils.importESModule(
  "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
);

/**
 * The navbar panel toggle, replacing Firefox's own #sidebar-button:
 *
 * - bork-panel-sidebar-button (far right): toggles the right panel
 *   sidebar through exactly the Cmd+Alt+S mechanism
 *   (lean-urlbar/sidebar-toggle.ts — bork-sidebar-hidden root attribute
 *   plus the bork.sidebar.hidden pref).
 *
 * The workspaces rail has no navbar button: it toggles via Cmd/Ctrl+Alt+W
 * (registered below) and the mouse-gesture action.
 *
 * CustomizableUI widgets are global singletons that outlive the window
 * that created them, while the feature layer (and its stores) is
 * per-window. The onCommand handler therefore never closes over module
 * state: it resolves the clicked window from the event and calls the
 * window-local hooks each window registers on itself in init().
 */

const PANEL_BUTTON_ID = "bork-panel-sidebar-button";
const PANEL_BUTTON_TOOLTIP = "Panel sidebar";
const HOOKS_PROP = "gBorkPanelToggles";
const STYLE_ID = "bork-panel-toggles-style";

type PanelToggleHooks = {
  toggleWorkspacesRail: () => void;
  togglePanelSidebar: () => void;
};

/* 16x16 sidebar glyph (fill="context-fill"): a rounded window outline
   with the right third filled. */
const RIGHT_PANEL_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDE2IDE2IiBmaWxsPSJjb250ZXh0LWZpbGwiIGZpbGwtb3BhY2l0eT0iY29udGV4dC1maWxsLW9wYWNpdHkiPjxwYXRoIGZpbGwtcnVsZT0iZXZlbm9kZCIgdHJhbnNmb3JtPSJtYXRyaXgoLTEgMCAwIDEgMTYgMCkiIGQ9Ik0zIDJoMTBhMiAyIDAgMCAxIDIgMnY4YTIgMiAwIDAgMS0yIDJIM2EyIDIgMCAwIDEtMi0yVjRhMiAyIDAgMCAxIDItMlptMyAxLjI1aDdhLjc1IC43NSAwIDAgMSAuNzUgLjc1djhhLjc1IC43NSAwIDAgMS0uNzUgLjc1SDZaIi8+PC9zdmc+";

const STYLE_TEXT = `
/* Firefox's native sidebar toggle is replaced by the bork panel button;
   the widget is also removed from the navbar via CustomizableUI. */
#sidebar-button {
  display: none !important;
}

#${PANEL_BUTTON_ID} {
  list-style-image: url("${RIGHT_PANEL_ICON}");
}

#${PANEL_BUTTON_ID} .toolbarbutton-icon {
  -moz-context-properties: fill, fill-opacity;
  fill: currentColor;
}
`;

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
 * re-pin the button to the navbar's last slot on every window open if
 * customization state drifted.
 */
const pinToEnd = (id: string): void => {
  try {
    const navbar = CustomizableUI.AREA_NAVBAR as string;
    const placement = CustomizableUI.getPlacementOfWidget(id) as
      | { area: string; position: number }
      | null;
    const ids = CustomizableUI.getWidgetIdsInArea(navbar) as string[];
    const isLast = placement?.area === navbar &&
      ids.length > 0 &&
      ids[ids.length - 1] === id;
    if (!isLast) {
      CustomizableUI.addWidgetToArea(id, navbar);
    }
  } catch (e) {
    console.error(`[panel-toggles] Failed to place widget ${id}:`, e);
  }
};

const ensureWidgets = (): void => {
  // Firefox's own sidebar toggle makes way for the panel button.
  try {
    CustomizableUI.removeWidgetFromArea("sidebar-button");
  } catch (e) {
    console.error("[panel-toggles] Failed to remove #sidebar-button:", e);
  }

  // Deliberate no-op handler: the command is handled by the per-window
  // delegate in init().
  createToggleWidget(PANEL_BUTTON_ID, PANEL_BUTTON_TOOLTIP, () => {});
  pinToEnd(PANEL_BUTTON_ID);
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
      toggleWorkspacesRail: () => toggleRailInThisWindow(),
      togglePanelSidebar: () => togglePanelSidebar(window),
    };
    (window as unknown as Record<string, unknown>)[HOOKS_PROP] = hooks;

    // The panel button's command events are handled HERE, per window, by a
    // document-level delegate. CustomizableUI's own api-widget onCommand
    // dispatch was verifiably inert for these nodes (widget registered,
    // node built, hooks live — click did nothing), and a delegate also
    // survives node rebuilds on customization.
    const onDelegatedCommand = (event: Event) => {
      const id = (event.target as Element | null)?.id;
      if (id === PANEL_BUTTON_ID) {
        hooks.togglePanelSidebar();
      }
    };
    window.addEventListener("command", onDelegatedCommand);
    onCleanup(() => {
      window.removeEventListener("command", onDelegatedCommand);
    });

    // Keyboard chord for the rail, same family as the rest of the bork
    // chrome controls (Cmd/Ctrl+Alt+letter): W toggles the workspaces
    // rail; S (panel sidebar) already lives in lean-urlbar's actions.
    gestureActions.registerActions([
      {
        name: "bork-toggle-workspaces-rail",
        // Resolve the hooks from the window the key was pressed in rather
        // than closing over this window's. The registry is a process-wide
        // singleton keyed by action name (actions.set(name, ...)), so every
        // window that opens overwrites the previous window's registration
        // — a closure over `hooks` sends the chord to whichever window
        // happened to open last, whatever window you actually pressed it
        // in. The window is passed in for exactly this reason, and each
        // one has already published its own hooks under HOOKS_PROP.
        fn: (win) =>
          (win as unknown as Record<string, PanelToggleHooks | undefined>)[
            HOOKS_PROP
          ]?.toggleWorkspacesRail(),
      },
    ]);

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
