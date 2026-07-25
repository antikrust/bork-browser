/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { DroppedRun, StreamAxis, WheelGuardReadout } from "./types.ts";

/**
 * The wheel rules that stop a horizontal <arrowscrollbox> from being scrolled
 * back by a macOS momentum tail — extracted so EVERY such box gets them, not
 * just the tab strip.
 *
 * Why it must be shared: the snap-back is stock toolkit behavior
 * (`arrowscrollbox.on_wheel` maps deltaY onto horizontal scrolling behind only
 * a 2-event axis filter), so it applies to any horizontal arrowscrollbox. The
 * original guard was scoped to #tabbrowser-tabs, which left bork's stack bar
 * (row 2 — the same widget) still snapping back. Worse for row 2: on_wheel
 * calls preventDefault() + stopPropagation() UNCONDITIONALLY whenever the box
 * is [overflowing], even when its axis filter refuses to scroll — so a tail
 * (or a wheel transaction still latched to the bar after the pointer has moved
 * away) is swallowed there instead of scrolling the page.
 *
 * See scrollback-error.md for the measured mechanism and the synthetic repro.
 */

/** A pause longer than this starts a fresh stream (re-latches axis and
 * direction). Momentum tails run gapless at display rate and the
 * touch-to-momentum handoff pause stays well under this. */
const STREAM_GAP_MS = 400;

/** A held reversal must clear runPeak * factor + 1 to count as a live
 * finger instead of a decaying tail's jitter. */
const PEAK_FACTOR = 1.05;

export const AXIS_RULE = 1;
export const REVERSAL_RULE = 2;
export const RECENTRE_RULE = 4;
export const GUARD_DEFAULT = AXIS_RULE | REVERSAL_RULE | RECENTRE_RULE;
export const GUARD_PREF = "floorp.tabstrip.wheelguard";

export interface GuardedBox extends Element {
  isRTLScrollbox?: boolean;
}

const READOUT_KEY = "__borkWheelGuard";

/**
 * The elimination readout, published at globalThis.__borkWheelGuard and SHARED
 * by every guarded box, so one read after a reproduction attempt says whether
 * any guard engaged on that gesture.
 */
export function getWheelGuardReadout(): WheelGuardReadout {
  const g = globalThis as Record<string, unknown> & typeof globalThis;
  let readout = g[READOUT_KEY] as WheelGuardReadout | undefined;
  if (!readout) {
    readout = {
      axisDropped: 0,
      reversalDropped: 0,
      recentresSuppressed: 0,
      lastRun: null,
      reset() {
        this.axisDropped = 0;
        this.reversalDropped = 0;
        this.recentresSuppressed = 0;
        this.lastRun = null;
      },
    };
    g[READOUT_KEY] = readout;
  }
  return readout;
}

export interface WheelGuardOptions {
  /** The arrowscrollbox to protect. */
  asb: GuardedBox;
  /** Ancestor to listen on, so capture always precedes the box's own
   * handler. */
  listenOn: EventTarget;
  /** Shared counters for the elimination readout. */
  readout: WheelGuardReadout;
  /** Called on a manual (user) wheel over the box — the strip uses it to arm
   * its recentre latch. */
  onManualWheel?: () => void;
}

/**
 * Install the axis-quarantine + reversal-hold rules on one arrowscrollbox.
 * Returns a cleanup function.
 */
export function attachWheelGuard(options: WheelGuardOptions): () => void {
  const { asb, listenOn, readout, onManualWheel } = options;

  let lastTs = 0;
  let streamAxis: StreamAxis | null = null;
  let streamDir = 0;
  let runPeak = -1;
  let run: DroppedRun | null = null;
  let errorReported = false;

  const drop = (event: WheelEvent, axis: StreamAxis, px: number): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!run) {
      run = { axis, events: 0, px: 0, endedAt: 0 };
      readout.lastRun = run;
    }
    run.events += 1;
    run.px += px;
    run.endedAt = Date.now();
  };

  const onWheelCapture = (event: Event): void => {
    const wheel = event as WheelEvent;
    try {
      const mode = Services.prefs.getIntPref(GUARD_PREF, GUARD_DEFAULT);
      if (mode <= 0) return;
      if (!(wheel.target instanceof Node) || !asb.contains(wheel.target)) {
        return;
      }
      onManualWheel?.();
      // Trackpads deliver pixel-mode streams; line/page devices have no
      // momentum machinery and pass untouched.
      if (wheel.deltaMode !== wheel.DOM_DELTA_PIXEL) return;
      // Enforcement mirrors stock on_wheel's bail-outs — but the stream model
      // must keep OBSERVING while enforcement is off (the box transiently
      // loses [overflowing] during tab churn). If observation paused too, a
      // momentum tail arriving as the first event after a blind window would
      // latch as a fresh gesture and pass wholesale.
      const enforcing = asb.hasAttribute("overflowing") &&
        asb.getAttribute("orient") !== "vertical";

      const absX = Math.abs(wheel.deltaX);
      const absY = Math.abs(wheel.deltaY);
      if (absX === 0 && absY === 0) return;

      // Same delta selection stock on_wheel performs.
      const isVertical = absY > absX;
      const rawDelta = isVertical ? wheel.deltaY : wheel.deltaX;
      const effDelta = isVertical && asb.isRTLScrollbox ? -rawDelta : rawDelta;
      const axis: StreamAxis = isVertical ? "v" : "h";
      const dir = effDelta < 0 ? -1 : 1;
      const mag = Math.abs(effDelta);

      const gap = wheel.timeStamp - lastTs;
      lastTs = wheel.timeStamp;

      // Fresh stream, or observe-only (a blind event reaches stock and becomes
      // the stream's reality — track it, never drop it).
      if (streamAxis === null || gap > STREAM_GAP_MS || !enforcing) {
        streamAxis = axis;
        streamDir = dir;
        runPeak = -1;
        run = null;
        return;
      }

      if (axis !== streamAxis) {
        if (streamAxis === "h" && (mode & AXIS_RULE) !== 0) {
          readout.axisDropped += 1;
          drop(wheel, axis, mag);
          return;
        }
        // Horizontal is the box's native axis — a stream turning
        // horizontal-dominant is the user, let it re-latch.
        streamAxis = axis;
        streamDir = dir;
        runPeak = -1;
        run = null;
        return;
      }

      if (dir === streamDir) {
        runPeak = -1;
        run = null;
        return;
      }

      if ((mode & REVERSAL_RULE) !== 0) {
        if (runPeak >= 0 && mag > runPeak * PEAK_FACTOR + 1) {
          streamDir = dir;
          runPeak = -1;
          run = null;
          return;
        }
        runPeak = Math.max(runPeak, mag);
        readout.reversalDropped += 1;
        drop(wheel, axis, mag);
        return;
      }

      streamDir = dir;
      runPeak = -1;
    } catch (e) {
      if (!errorReported) {
        errorReported = true;
        console.error("[TabStripWheelGuard]", e);
      }
    }
  };

  listenOn.addEventListener("wheel", onWheelCapture, {
    capture: true,
    passive: false,
  });

  return () => {
    listenOn.removeEventListener("wheel", onWheelCapture, { capture: true });
  };
}

/**
 * Stop an arrowscrollbox's click-to-scroll loop. Holding a scroll arrow starts
 * a loop whose only exit is _stopScroll(), which stock calls from
 * on_mouseup/on_mouseout — both of which bail out unless the event's
 * originalTarget IS an arrow button. The left arrow inherits
 * `disabled=scrolledtostart`, and a disabled XUL button dispatches no mouse
 * events, so the release is never seen and the loop runs every frame forever.
 */
export function stopScrollLoop(box: Element | null | undefined): void {
  if (!box) return;
  const b = box as Element & {
    _stopScroll?: () => void;
    _scrollTimer?: { cancel?: () => void };
    _arrowScrollAnim?: { stop?: () => void };
    _mousedown?: boolean;
  };
  // A no-op unless a press is outstanding: _stopScroll() is exactly what stock
  // runs on a normal release, so holding an arrow still scrolls.
  b._stopScroll?.();
  b._scrollTimer?.cancel?.();
  b._arrowScrollAnim?.stop?.();
  b._mousedown = false;
}

/** Install the release watchdog for one box; returns a cleanup function. */
export function attachReleaseWatchdog(box: Element): () => void {
  const onRelease = (): void => stopScrollLoop(box);
  document.addEventListener("mouseup", onRelease, true);
  document.addEventListener("pointercancel", onRelease, true);
  document.addEventListener("blur", onRelease, true);
  return () => {
    document.removeEventListener("mouseup", onRelease, true);
    document.removeEventListener("pointercancel", onRelease, true);
    document.removeEventListener("blur", onRelease, true);
    onRelease();
  };
}
