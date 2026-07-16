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
    this.installCloseTracer();
    this.installWindowWatcher();
    this.installStateTracer();
    this.rescueOffscreenWindow();
    void this.applyDefaultSearch();
    this.relocateExtensionButtons();
  }

  /**
   * TEMP(derp): log window state transitions (minimize/restore/fullscreen,
   * occlusion) — a minimized window "disappears" into the Dock with no
   * close event, which matches the vanish reports.
   */
  private installStateTracer(): void {
    try {
      const w = globalThis as unknown as Window & { windowState: number };
      addEventListener("sizemodechange", () => {
        console.error(
          `[derp-trace] sizemodechange windowState=${w.windowState} (1=maximized 2=minimized 3=normal 4=fullscreen)`,
        );
      });
      addEventListener("occlusionstatechange", () => {
        console.error("[derp-trace] occlusionstatechange");
      });
      addEventListener("fullscreenchange", () => {
        console.error("[derp-trace] fullscreenchange");
      });
      // Space/desktop switches and full coverage flip document.hidden
      // without any of the events above.
      document.addEventListener("visibilitychange", () => {
        console.error(
          `[derp-trace] visibilitychange hidden=${document.hidden}`,
        );
      });
      // Poll geometry: moveTo/moveBy relocations and layout collapses fire
      // no events at all. Logs only when something changes.
      let last = "";
      setInterval(() => {
        try {
          const r = document.documentElement?.getBoundingClientRect();
          const rootSize = r
            ? `${Math.round(r.width)}x${Math.round(r.height)}`
            : "?";
          // Root rect stays full-size even when the toolbars or content
          // area collapse to nothing, so measure those separately.
          const toolboxH = Math.round(
            document.getElementById("navigator-toolbox")
              ?.getBoundingClientRect().height ?? -1,
          );
          const contentH = Math.round(
            document.getElementById("browser")
              ?.getBoundingClientRect().height ?? -1,
          );
          const sample =
            `pos=${w.screenX},${w.screenY} size=${w.outerWidth}x${w.outerHeight} root=${rootSize} toolbox=${toolboxH} content=${contentH} hidden=${document.hidden}`;
          if (sample !== last) {
            console.error(
              last
                ? `[derp-trace] geometry ${last} -> ${sample}`
                : `[derp-trace] geometry baseline ${sample}`,
            );
            last = sample;
          }
        } catch {
          // window tearing down
        }
      }, 2000);
    } catch (e) {
      console.error("[derp-defaults] state tracer failed:", e);
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
          console.error(
            `[derp-trace] window opened offscreen (x=${w.screenX} y=${w.screenY}) — rescuing`,
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

  /**
   * TEMP(derp): global watcher — logs every chrome window open/close even
   * for windows where the feature layer failed to load (per-window tracers
   * can't see those). Registered once per app via a flag on Services.
   */
  private installWindowWatcher(): void {
    try {
      const s = Services as unknown as {
        _derpWindowWatcherHooked?: boolean;
        ww: {
          registerNotification: (
            observer: (subject: unknown, topic: string) => void,
          ) => void;
        };
        wm: { getEnumerator: (type: string | null) => Iterator<unknown> };
      };
      if (s._derpWindowWatcherHooked) return;
      s._derpWindowWatcherHooked = true;
      const countWindows = (): number => {
        let n = 0;
        try {
          const en = s.wm.getEnumerator(
            "navigator:browser",
          ) as unknown as { hasMoreElements: () => boolean; getNext: () => unknown };
          while (en.hasMoreElements()) {
            en.getNext();
            n++;
          }
        } catch {
          n = -1;
        }
        return n;
      };
      s.ww.registerNotification((subject: unknown, topic: string) => {
        try {
          const href = (subject as { location?: { href?: string } })
            ?.location?.href ?? "?";
          console.error(
            `[derp-trace] ${topic} href=${href} browserWindows=${countWindows()}`,
          );
        } catch {
          console.error(`[derp-trace] ${topic}`);
        }
      });
      this.logger.info("Global window watcher installed");
    } catch (e) {
      console.error("[derp-defaults] window watcher failed:", e);
    }
  }

  /**
   * TEMP(derp): windows have been vanishing without a crash report. Trace
   * every JS-initiated window close with its call stack so the culprit
   * names itself in the launch log. Remove once the vanisher is caught.
   */
  private installCloseTracer(): void {
    try {
      const win = globalThis as unknown as {
        close: () => void;
      };
      const origClose = win.close.bind(globalThis);
      win.close = () => {
        console.error(
          "[derp-trace] window.close() called from:",
          new Error("close-tracer").stack,
        );
        origClose();
      };
      addEventListener("unload", () => {
        console.error("[derp-trace] chrome window unloading");
      });
    } catch (e) {
      console.error("[derp-defaults] close tracer failed:", e);
    }
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
