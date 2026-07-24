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
import { gestureActions } from "../mouse-gesture/utils/gestures.ts";
import { LeanUrlbarStyle } from "./lean-urlbar.tsx";
import {
  SIDEBAR_HIDDEN_ATTR,
  SIDEBAR_HIDDEN_PREF,
  togglePanelSidebar,
} from "./sidebar-toggle.ts";

const AUTOHIDE_ENABLED_PREF = "bork.urlbar.autohide.enabled";
const SIDEBAR_TOGGLE_ENABLED_PREF = "bork.sidebar.toggle.enabled";
const HIDDEN_PREF = "bork.urlbar.hidden";
const HIDDEN_ATTR = "bork-urlbar-hidden";
const PEEK_ATTR = "bork-urlbar-peek";

/**
 * "Lean" address bar: the nav bar can be toggled away entirely (bound to
 * the A key by default). While hidden, opening a new tab or focusing the
 * urlbar (Cmd+L) slides just the URL input over the tab strip; Enter,
 * Escape, or blur slides it away again.
 */
@noraComponent(import.meta.hot)
export default class LeanUrlbar extends NoraComponentBase {
  init(): void {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }
    const root = document.documentElement;
    const urlbar = document.getElementById("urlbar");
    if (!root) return;

    // Main browser windows only. Popup windows (window.open with features)
    // carry chromehidden and show minimal chrome — hiding it orphans the
    // top-layer urlbar into a bar floating over the desktop.
    if (
      root.getAttribute("windowtype") !== "navigator:browser" ||
      (root.getAttribute("chromehidden") ?? "") !== ""
    ) {
      return;
    }

    render(LeanUrlbarStyle, document.head, { hotCtx: import.meta.hot });

    // Address bar "jumps up when you type": the bar is a top-layer popover
    // that Firefox grows CENTERED when results open ([breakout-extend]), so
    // the field rides up by half the height it gains. styles.css pins it to
    // grow downward instead, but that needs the field's resting top — which
    // varies with chrome height (one tab row vs the stack bar also showing).
    // Capture it into --bork-urlbar-rest-inset whenever the bar is at rest.
    if (urlbar) {
      const captureRestInset = () => {
        if (urlbar.hasAttribute("breakout-extend")) return;
        const top = getComputedStyle(urlbar).insetBlockStart;
        if (top && top !== "auto") {
          urlbar.style.setProperty("--bork-urlbar-rest-inset", top);
        }
      };
      captureRestInset();
      const toolbox = document.getElementById("navigator-toolbox");
      if (toolbox && typeof ResizeObserver !== "undefined") {
        new ResizeObserver(() => captureRestInset()).observe(toolbox);
      }
      // Re-capture once the bar settles back to rest after each use.
      urlbar.addEventListener("focusout", () => {
        requestAnimationFrame(captureRestInset);
      });
    }

    // Feature switch: address-bar hiding is off by default (user request,
    // 2026-07-16). The code stays; flip the pref to bring it back. The
    // sidebar toggle below is independent and stays active either way.
    const autohideEnabled = Services.prefs.getBoolPref(
      AUTOHIDE_ENABLED_PREF,
      false,
    );
    // Also off while fault-finding (user request, 2026-07-16): eliminates
    // the sidebar show/hide path so the next incident points at tab stacks
    // or elsewhere.
    const sidebarToggleEnabled = Services.prefs.getBoolPref(
      SIDEBAR_TOGGLE_ENABLED_PREF,
      false,
    );

    const unpeek = () => root.removeAttribute(PEEK_ATTR);

    const isHidden = () => root.hasAttribute(HIDDEN_ATTR);

    // Session-restore opens tabs (and focuses the urlbar) during startup,
    // which would trigger a peek nobody asked for and leave a lone URL
    // strip stuck over the tab row ("one line across the screen").
    const startupGraceUntil = Date.now() + 5000;

    const peek = () => {
      if (!isHidden()) return;
      if (Date.now() < startupGraceUntil) return;
      // Zen mode owns chrome reveals while active.
      if (root.hasAttribute("zenmode")) return;
      root.setAttribute(PEEK_ATTR, "");
      setTimeout(() => {
        const gURLBar = (globalThis as unknown as {
          gURLBar?: { focus: () => void; select: () => void };
        }).gURLBar;
        gURLBar?.focus();
        gURLBar?.select();
      }, 0);
    };

    const applyHidden = (hidden: boolean) => {
      if (hidden) {
        // The nav bar's height is its content's, and auto does not
        // interpolate — the collapse needs a real number to travel from.
        // Measured at the moment of hiding rather than cached, so it stays
        // right when the toolbar's contents change; showing again reuses
        // the value, which is the height it is returning to.
        const nav = document?.getElementById("nav-bar");
        const h = nav?.getBoundingClientRect().height ?? 0;
        if (h > 0) {
          root.style.setProperty("--bork-navbar-height", `${Math.ceil(h)}px`);
        }
        root.setAttribute(HIDDEN_ATTR, "");
      } else {
        root.removeAttribute(HIDDEN_ATTR);
        unpeek();
      }
    };
    if (autohideEnabled) {
      applyHidden(Services.prefs.getBoolPref(HIDDEN_PREF, false));
    } else {
      // Switched off: make sure no window starts hidden, and drop any saved
      // hidden state so re-enabling later starts with the bar visible.
      applyHidden(false);
      try {
        Services.prefs.clearUserPref(HIDDEN_PREF);
      } catch {
        // no saved value
      }
    }

    // Panel sidebar visibility. (floorp.panelSidebar.enabled looks like the
    // switch but nothing in the sidebar UI observes it for visibility, so
    // we own an attribute + CSS instead.)
    const applySidebarHidden = (hidden: boolean) => {
      if (hidden) root.setAttribute(SIDEBAR_HIDDEN_ATTR, "");
      else root.removeAttribute(SIDEBAR_HIDDEN_ATTR);
    };
    if (sidebarToggleEnabled) {
      applySidebarHidden(
        Services.prefs.getBoolPref(SIDEBAR_HIDDEN_PREF, false),
      );
    } else {
      // Switched off: sidebar always visible, saved hidden state dropped.
      applySidebarHidden(false);
      try {
        Services.prefs.clearUserPref(SIDEBAR_HIDDEN_PREF);
      } catch {
        // no saved value
      }
    }

    // No pref observers: toggles are per-window (the prefs only seed the
    // initial state of windows opened later).

    // Actions for the keyboard-shortcut / mouse-gesture systems.
    gestureActions.registerActions([
      {
        name: "bork-toggle-urlbar",
        fn: () => {
          // Stays registered so the shortcut binding resolves, but does
          // nothing while the feature switch is off.
          if (!autohideEnabled) return;
          // This window only; the pref just seeds future windows.
          const next = !root.hasAttribute(HIDDEN_ATTR);
          applyHidden(next);
          Services.prefs.setBoolPref(HIDDEN_PREF, next);
        },
      },
      {
        name: "bork-toggle-panel-sidebar",
        fn: () => {
          // Registered so the shortcut binding resolves; inert while the
          // feature switch is off. The toggle itself is shared with the
          // bork-panel-sidebar-button navbar widget (sidebar-toggle.ts).
          if (!sidebarToggleEnabled) return;
          togglePanelSidebar(window);
        },
      },
    ]);

    const isInUrlbar = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element) || !urlbar) return false;
      return target === urlbar || urlbar.contains(target);
    };

    const onTabOpen = () => peek();

    const onFocusIn = (event: FocusEvent) => {
      if (isInUrlbar(event.target)) peek();
    };

    const onFocusOut = (event: FocusEvent) => {
      if (!isInUrlbar(event.target)) return;
      // Delay: the urlbar dropdown swaps focus around while open.
      setTimeout(() => {
        const focused = document?.activeElement ?? null;
        const stillInside = isInUrlbar(focused);
        if (!stillInside && !urlbar?.hasAttribute("open")) {
          unpeek();
        }
      }, 150);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && root.hasAttribute(PEEK_ATTR)) {
        unpeek();
      }
    };

    // Peek machinery only runs while the feature is on; with it off the
    // bar is always visible and there is nothing to slide in or out.
    if (autohideEnabled) {
      addEventListener("TabOpen", onTabOpen);
      document.addEventListener("focusin", onFocusIn);
      document.addEventListener("focusout", onFocusOut);
      addEventListener("keydown", onKeyDown, true);
    }

    onCleanup(() => {
      removeEventListener("TabOpen", onTabOpen);
      document?.removeEventListener("focusin", onFocusIn);
      document?.removeEventListener("focusout", onFocusOut);
      removeEventListener("keydown", onKeyDown, true);
      root.removeAttribute(PEEK_ATTR);
    });

    this.logger.info(
      `LeanUrlbar initialized (autohide ${
        autohideEnabled ? "on" : "off"
      }, sidebar toggle ${sidebarToggleEnabled ? "on" : "off"})`,
    );
  }
}
