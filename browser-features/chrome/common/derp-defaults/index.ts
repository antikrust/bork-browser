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

/** Timestamp for trace lines so incidents can be correlated to the second. */
const ts = (): string => new Date().toISOString().slice(11, 23);

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
      // Identify WHICH chrome document is talking: the main windows share
      // href, so include the web-panel id query and window type. A fresh
      // document announcing itself mid-session is a lead, not noise.
      const docId = (): string => {
        const href = String(
          (globalThis as unknown as { location?: { href?: string } })
            .location?.href ?? "?",
        );
        const type = document?.documentElement?.getAttribute("windowtype") ??
          "?";
        return `href=${href} windowtype=${type}`;
      };
      addEventListener("sizemodechange", () => {
        console.error(
          `[derp-trace ${ts()}] sizemodechange windowState=${w.windowState} (1=maximized 2=minimized 3=normal 4=fullscreen) ${docId()}`,
        );
      });
      // Occlusion-flap rescue: macOS occlusion state can thrash (observed:
      // 10 visibility flips in 1ms — animated wallpapers keep the window
      // server recalculating). The suspend/resume race can drop the
      // window's compositing surface, leaving a healthy window drawn as an
      // empty frame ("everything vanished"). A tiny resize forces the
      // window server to re-composite — the same reason dragging the
      // window used to bring it back. Skip while minimized/fullscreen.
      let flapTimes: number[] = [];
      let rescuePending = false;
      const scheduleRecomposite = (reason: string) => {
        if (rescuePending) return;
        rescuePending = true;
        console.error(
          `[derp-trace ${ts()}] re-composite scheduled (${reason}) ${docId()}`,
        );
        setTimeout(() => {
          try {
            if (w.windowState === 2 || w.windowState === 4) {
              rescuePending = false;
              return;
            }
            const win = globalThis as unknown as Window;
            win.resizeBy(1, 1);
            setTimeout(() => {
              try {
                win.resizeBy(-1, -1);
              } catch {
                // window going away
              }
              rescuePending = false;
              flapTimes = [];
              console.error(
                `[derp-trace ${ts()}] re-composite done hidden=${document.hidden}`,
              );
            }, 80);
          } catch (e) {
            rescuePending = false;
            console.error("[derp-defaults] re-composite rescue failed:", e);
          }
        }, 800);
      };
      const noteFlap = () => {
        const now = Date.now();
        flapTimes = flapTimes.filter((t) => now - t < 1200);
        flapTimes.push(now);
        if (flapTimes.length >= 5) {
          scheduleRecomposite(`occlusion flap ${flapTimes.length} events <1.2s`);
        }
      };
      // Main-thread stall detector: the observed 10-events-in-1ms bursts
      // are queued notifications delivered after a long main-thread block,
      // and a stalled window's surface can be dropped by the window server
      // (window stays blank afterwards until something re-composites it).
      // Measure event-loop lag directly and self-heal after big stalls.
      let lastTick = Date.now();
      setInterval(() => {
        const now = Date.now();
        const lag = now - lastTick - 250;
        lastTick = now;
        if (lag > 1500) {
          console.error(
            `[derp-trace ${ts()}] main-thread stall ~${lag}ms ${docId()}`,
          );
          scheduleRecomposite(`stall ${lag}ms`);
        }
      }, 250);
      addEventListener("occlusionstatechange", () => {
        noteFlap();
        console.error(`[derp-trace ${ts()}] occlusionstatechange ${docId()}`);
      });
      addEventListener("fullscreenchange", () => {
        console.error(`[derp-trace ${ts()}] fullscreenchange ${docId()}`);
      });
      // Space/desktop switches and full coverage flip document.hidden
      // without any of the events above. A hidden=false with no prior
      // hidden=true means a NEW chrome document just materialized.
      document.addEventListener("visibilitychange", () => {
        noteFlap();
        console.error(
          `[derp-trace ${ts()}] visibilitychange hidden=${document.hidden} ${docId()}`,
        );
      });
      console.error(`[derp-trace ${ts()}] state tracer armed ${docId()}`);
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
                ? `[derp-trace ${ts()}] geometry ${last} -> ${sample}`
                : `[derp-trace ${ts()}] geometry baseline ${sample}`,
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
            `[derp-trace ${ts()}] ${topic} href=${href} browserWindows=${countWindows()}`,
          );
        } catch {
          console.error(`[derp-trace ${ts()}] ${topic}`);
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
          `[derp-trace ${ts()}] window.close() called from:`,
          new Error("close-tracer").stack,
        );
        origClose();
      };
      addEventListener("unload", () => {
        console.error(`[derp-trace ${ts()}] chrome window unloading`);
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
