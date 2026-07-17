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

const SEARCH_APPLIED_PREF = "derp.search.defaultApplied";
const DEFAULT_ENGINE = "DuckDuckGo";


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
