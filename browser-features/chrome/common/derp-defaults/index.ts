/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  noraComponent,
  NoraComponentBase,
} from "#features-chrome/utils/base.ts";

const { CustomizableUI } = ChromeUtils.importESModule(
  "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
);

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs",
);

const SEARCH_APPLIED_PREF = "derp.search.defaultApplied";
const DEFAULT_ENGINE = "DuckDuckGo";

/** Our name, as it should read wherever a product name is shown. */
const BRAND_NAME = "Derp";

/**
 * The macOS application menu items that embed the product name. nsMenuBarX
 * hides these XUL nodes and builds the native menu from them.
 */
const MAC_APP_MENU_IDS = [
  "aboutName",
  "menu_mac_hide_app",
  "menu_FileQuitItem",
];


/**
 * derp runtime defaults that can't be expressed as plain prefs:
 * - DuckDuckGo as the default search engine (applied once per profile,
 *   user's later choice is respected).
 * - Extension toolbar buttons live in the unified extensions panel
 *   (puzzle button) instead of cluttering the nav bar.
 */
@noraComponent(import.meta.hot)
export default class DerpDefaults extends NoraComponentBase {
  init(): void {
    this.rescueOffscreenWindow();
    void this.applyDefaultSearch();
    this.relocateExtensionButtons();
    this.brandMacAppMenu();
    this.fixOpenPreferencesWindow();
  }

  /**
   * Settings must open in the window you asked from. Stock openPreferences
   * fails that twice over: it targets Services.wm.getMostRecentWindow
   * (recency can lag the click on macOS), and its switchToTabHavingURI
   * searches EVERY window for an existing settings tab and switches focus
   * there — with two windows, Settings appeared to open "in the other
   * window". This version is strictly window-local: reuse a settings tab
   * in THIS window, else open a new one HERE.
   */
  private fixOpenPreferencesWindow(): void {
    type SettingsBrowser = {
      currentURI?: { spec?: string } | null;
      contentDocument?: { readyState?: string } | null;
      contentWindow?: { gotoPref?: (pane: string) => void } | null;
      loadURI?: (uri: unknown, opts: Record<string, unknown>) => void;
      addEventListener: (
        type: string,
        fn: () => void,
        opts: Record<string, unknown>,
      ) => void;
    };
    type SettingsTab = { linkedBrowser?: SettingsBrowser | null };
    type PrefWindow = typeof window & {
      openPreferences?: (
        paneID?: string,
        extraArgs?: { urlParams?: Record<string, string | undefined> },
      ) => Promise<void> | void;
      openTrustedLinkIn?: (url: string, where: string) => void;
      gBrowser?: {
        tabs: SettingsTab[];
        selectedTab: SettingsTab;
        selectedBrowser?: SettingsBrowser;
      };
    };
    const win = window as PrefWindow;
    const orig = win.openPreferences?.bind(win);
    if (!orig || !win.openTrustedLinkIn || !win.gBrowser) return;
    const isSettingsUri = (u: string): boolean =>
      u.startsWith("about:settings") || u.startsWith("about:preferences");
    win.openPreferences = async (paneID, extraArgs) => {
      try {
        const friendly = (paneID ?? "").replace(
          /^pane./,
          (m) => m[4].toLowerCase(),
        );
        let params: URLSearchParams | null = null;
        if (extraArgs?.urlParams) {
          params = new URLSearchParams();
          for (const [name, value] of Object.entries(extraArgs.urlParams)) {
            if (value !== undefined) params.set(name, value);
          }
        }
        const suffix = (params ? `?${params}` : "") +
          (friendly ? `#${friendly}` : "");
        const gb = win.gBrowser!;
        let existing: SettingsTab | null = null;
        for (const t of gb.tabs) {
          let u = "";
          try {
            u = t.linkedBrowser?.currentURI?.spec ?? "";
          } catch {
            // lazy tab without a resolvable URI — not a settings tab
          }
          if (isSettingsUri(u)) {
            existing = t;
            break;
          }
        }
        if (!existing) {
          win.openTrustedLinkIn!(`about:settings${suffix}`, "tab");
          return;
        }
        gb.selectedTab = existing;
        const browser = existing.linkedBrowser;
        if (!browser || !suffix) return;
        const current = (() => {
          try {
            return browser.currentURI?.spec ?? "";
          } catch {
            return "";
          }
        })();
        if (current.endsWith(suffix) === false) {
          if (paneID && browser.contentWindow?.gotoPref) {
            if (browser.contentDocument?.readyState !== "complete") {
              await new Promise<void>((resolve) =>
                browser.addEventListener("load", resolve, {
                  capture: true,
                  once: true,
                })
              );
            }
            browser.contentWindow.gotoPref(paneID);
          } else {
            browser.loadURI?.(
              Services.io.newURI(`about:settings${suffix}`),
              {
                triggeringPrincipal: Services.scriptSecurityManager
                  .getSystemPrincipal(),
              },
            );
          }
        }
      } catch (e) {
        console.error(
          "[derp-defaults] window-local openPreferences failed, using stock:",
          e,
        );
        return orig(paneID, extraArgs);
      }
    };
  }

  /**
   * Put our name in the macOS application menu ("About Derp", "Hide Derp",
   * "Quit Derp").
   *
   * These labels come from menubar.ftl via `-brand-shorter-name`, which the
   * branding patch sets to Derp — but only for en-US, the one locale whose
   * files ship in the runtime. Under any other negotiated locale (en-GB here,
   * with or without a language pack installed) that lookup does not land and
   * Gecko falls back to the app name compiled into the runtime binary, which
   * is still Floorp and cannot be changed without building Gecko. A language
   * pack makes it worse rather than better: Mozilla's carries its own
   * branding, so the same items come out saying Firefox.
   *
   * So rather than translate, substitute — keep whatever wording the active
   * locale produced and correct only the product name inside it. Re-asserted
   * through a MutationObserver because Gecko writes these labels late and
   * again on locale changes.
   */
  private brandMacAppMenu(): void {
    if (AppConstants.platform !== "macosx") return;
    try {
      const doc = (globalThis as unknown as Window).document;
      // With --with-app-basename=Derp the compiled name is now Derp, so these
      // items are native "About Derp" — EXCEPT under a non-en-US locale whose
      // language pack ships its own branding. A Floorp-repackaged Mozilla
      // langpack (e.g. en-GB, carried over from a Floorp profile) reinjects
      // "Floorp"; a stock Mozilla one injects "Firefox". Strip both plus the
      // compiled name defensively.
      const wrongNames = [Services.appinfo.name, "Floorp", "Firefox", "Nightly"]
        .filter((n) => n && n !== BRAND_NAME);

      const correct = () => {
        for (const id of MAC_APP_MENU_IDS) {
          const el = doc.getElementById(id);
          const label = el?.getAttribute("label");
          if (!el || !label) continue;
          const fixed = wrongNames.reduce(
            (acc, name) => acc.split(name).join(BRAND_NAME),
            label,
          );
          // Only write on a real change, so our own mutation settles.
          if (fixed !== label) el.setAttribute("label", fixed);
        }
      };

      correct();
      const observer = new MutationObserver(correct);
      const attachTo = (el: Element) =>
        observer.observe(el, { attributes: true, attributeFilter: ["label"] });

      let attached = 0;
      for (const id of MAC_APP_MENU_IDS) {
        const el = doc.getElementById(id);
        if (el) {
          attachTo(el);
          attached++;
        }
      }

      // The macOS app-menu items are frequently created AFTER this feature
      // inits (Gecko builds the native menu late, and later still under a
      // non-en-US locale whose langpack labels arrive with a delay). If they
      // were not present yet, per-element observers above caught nothing and
      // the late "Floorp"/"Firefox" labels would never be corrected. Watch the
      // menubar for the items appearing, and re-assert on a short schedule as a
      // backstop, until every item exists and has been observed.
      if (attached < MAC_APP_MENU_IDS.length) {
        const menubar = doc.getElementById("main-menubar") ?? doc.documentElement;
        const settle = new MutationObserver(() => {
          correct();
          let now = 0;
          for (const id of MAC_APP_MENU_IDS) {
            if (doc.getElementById(id)) now++;
          }
          if (now === MAC_APP_MENU_IDS.length) {
            for (const id of MAC_APP_MENU_IDS) {
              const el = doc.getElementById(id);
              if (el) attachTo(el);
            }
            settle.disconnect();
          }
        });
        if (menubar) settle.observe(menubar, { childList: true, subtree: true });
        // Timed backstop in case the labels are written without a DOM mutation
        // this observer sees.
        for (const delay of [250, 750, 1500, 3000]) {
          (globalThis as unknown as Window).setTimeout(correct, delay);
        }
      }
    } catch (e) {
      console.error("[derp-defaults] Failed to brand the app menu:", e);
    }
  }

  /**
   * If a window's saved geometry places it outside its display (e.g. after
   * it was dragged offscreen and that position persisted), it opens
   * invisible. Detect and walk it back to a sane spot. Uses the window's
   * own screen object so multi-display setups aren't false-flagged.
   */
  private rescueOffscreenWindow(): void {
    setTimeout(() => {
      try {
        const w = globalThis as unknown as Window & {
          screen: {
            availLeft?: number;
            availTop?: number;
            availWidth: number;
            availHeight: number;
          };
        };
        const sx = w.screen.availLeft ?? 0;
        const sy = w.screen.availTop ?? 0;
        const sw = w.screen.availWidth;
        const sh = w.screen.availHeight;
        const margin = 60;
        const offscreen = w.screenX > sx + sw - margin ||
          w.screenY > sy + sh - margin ||
          w.screenX + w.outerWidth < sx + margin ||
          w.screenY + w.outerHeight < sy + margin;
        if (offscreen) {
          console.log(
            `[derp-defaults] window opened offscreen (x=${w.screenX} y=${w.screenY}) — rescuing`,
          );
          w.moveTo(sx + margin, sy + margin);
          if (w.outerWidth < 500 || w.outerHeight < 350) {
            w.resizeTo(1200, 800);
          }
        }
      } catch (e) {
        console.error("[derp-defaults] offscreen rescue failed:", e);
      }
    }, 1500);
  }

  private async applyDefaultSearch(): Promise<void> {
    try {
      if (Services.prefs.getBoolPref(SEARCH_APPLIED_PREF, false)) {
        return;
      }
      const search = Services.search as unknown as {
        init?: () => Promise<void>;
        getEngineByName: (name: string) => Promise<unknown> | unknown;
        setDefault: (engine: unknown, reason?: unknown) => Promise<void>;
      };
      await search.init?.();
      const engine = await search.getEngineByName(DEFAULT_ENGINE);
      if (!engine) {
        this.logger.warn(`Search engine ${DEFAULT_ENGINE} not found.`);
        return;
      }
      const reason = (Ci as unknown as {
        nsISearchService?: { CHANGE_REASON_USER?: unknown };
      }).nsISearchService?.CHANGE_REASON_USER;
      await search.setDefault(engine, reason);
      Services.prefs.setBoolPref(SEARCH_APPLIED_PREF, true);
      this.logger.info(`Default search engine set to ${DEFAULT_ENGINE}`);
    } catch (e) {
      console.error("[derp-defaults] Failed to set default search:", e);
    }
  }

  private relocateExtensionButtons(): void {
    const addonsArea = (CustomizableUI as unknown as {
      AREA_ADDONS?: string;
    }).AREA_ADDONS ?? "unified-extensions";

    const moveIfExtension = (id: string, area: string | null) => {
      if (area !== "nav-bar" || !id?.endsWith("-browser-action")) return;
      try {
        CustomizableUI.addWidgetToArea(id, addonsArea);
      } catch (e) {
        console.error(`[derp-defaults] Failed to move widget ${id}:`, e);
      }
    };

    try {
      for (
        const id of CustomizableUI.getWidgetIdsInArea("nav-bar") as string[]
      ) {
        moveIfExtension(id, "nav-bar");
      }
      const listener = {
        onWidgetAdded: (id: string, area: string) =>
          moveIfExtension(id, area),
      };
      CustomizableUI.addListener(listener);
    } catch (e) {
      console.error(
        "[derp-defaults] Failed to relocate extension buttons:",
        e,
      );
    }
  }
}
