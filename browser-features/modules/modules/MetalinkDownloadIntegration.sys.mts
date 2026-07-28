/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Makes a segmented Metalink transfer a real Firefox download: it appears in
 * the downloads panel and about:downloads, drives the toolbar progress
 * indicator, and its Cancel button works.
 *
 * Downloads.sys.mjs normally owns the transfer through a "saver". The two stock
 * savers are `copy` (Necko fetches one source) and `legacy` (an external
 * nsITransfer reports in) — and `DownloadSaver.fromSerializable` throws on any
 * other type, so a custom saver cannot be passed to createDownload. What CAN be
 * done is what Download.fromSerializable itself does: assign `download.saver`
 * and back-link `saver.download`. So we build an ordinary download and swap the
 * saver out before starting it.
 *
 * The Download object then treats our multi-mirror transfer as its own: the
 * progress it shows is real, and cancelling it aborts our fetches.
 */

import type {
  MetalinkFile,
  MetalinkHash,
  MetalinkUrl,
} from "./Metalink.sys.mts";
import { downloadSegmented } from "./MetalinkSegmented.sys.mts";
import type { SegmentedResult } from "./MetalinkSegmented.sys.mts";

// setTimeout is NOT a global in .sys.mjs module scope — it lives in
// Timer.sys.mjs. Calling the bare name here threw a ReferenceError inside the
// saver, which surfaced as the download failing after the bytes had already
// been fetched and verified.
const { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs",
) as { setTimeout: (fn: () => void, ms: number) => number };

const { Downloads } = ChromeUtils.importESModule(
  "resource://gre/modules/Downloads.sys.mjs",
) as {
  Downloads: {
    createDownload(opts: Record<string, unknown>): Promise<DownloadLike>;
    getList(kind: unknown): Promise<{ add(d: DownloadLike): Promise<void> }>;
    ALL: unknown;
  };
};

interface DownloadLike {
  saver: unknown;
  start(): Promise<void>;
  target: { path: string; size?: number };
  source: { url: string };
  contentType?: string;
  succeeded?: boolean;
  canceled?: boolean;
  error?: unknown;
}

type SetProgressFn = (
  currentBytes: number,
  totalBytes: number,
  hasPartialData: boolean,
) => void;

/**
 * Downloads that are ours, so the UI can badge them. A WeakSet keyed on the
 * Download object: the downloads list owns their lifetime, and we must not be
 * the reason one is kept alive.
 */
const metalinkDownloads = new WeakSet<object>();

/**
 * Download._setBytes in DownloadCore.sys.mjs drops any progress update that
 * arrives within this many ms of the last one. Mirrored here so the final
 * report can be timed to actually land.
 */
const PROGRESS_THROTTLE_MS = 400;

export function isMetalinkDownload(download: object): boolean {
  return metalinkDownloads.has(download);
}

/** Details the UI wants for a badge/tooltip, keyed the same way. */
const details = new WeakMap<object, {
  mirrorCount: number;
  usedMirrors: number;
  verified: boolean;
  hashType?: string;
}>();

export function metalinkDetails(download: object) {
  return details.get(download);
}

/**
 * A DownloadSaver whose `execute` runs the segmented transfer.
 *
 * Contract taken from DownloadCore.sys.mjs: execute(setProgressBytesFn,
 * setPropertiesFn) resolves on success and rejects on failure, cancel() aborts,
 * removePartialData() cleans up, toSerializable() must round-trip through
 * DownloadSaver.fromSerializable.
 */
class MetalinkSaver {
  download: DownloadLike | null = null;
  // Recreated on every execute(): retry calls start() again on the same saver,
  // and a spent controller would cancel the new attempt instantly.
  #controller = new AbortController();
  #file: MetalinkFile;
  #mirrors: MetalinkUrl[];
  #hash: MetalinkHash | undefined;
  #result: SegmentedResult | null = null;
  #lastProgressAt = 0;

  constructor(
    file: MetalinkFile,
    mirrors: MetalinkUrl[],
    hash: MetalinkHash | undefined,
  ) {
    this.#file = file;
    this.#mirrors = mirrors;
    this.#hash = hash;
  }

  get result(): SegmentedResult | null {
    return this.#result;
  }

  async execute(aSetProgressBytesFn: SetProgressFn): Promise<void> {
    const target = this.download?.target.path;
    if (!target) throw new Error("Metalink download has no target path");
    this.#controller = new AbortController();

    // Report 0 immediately so the panel shows a determinate bar from the start
    // rather than sitting on "unknown size" until the first chunk lands.
    aSetProgressBytesFn(0, this.#file.size ?? -1, false);

    const result = await downloadSegmented(
      this.#file,
      this.#mirrors,
      this.#hash,
      target,
      (p) => {
        this.#lastProgressAt = Date.now();
        // false: no resumable part file exists. Reporting true made a
        // canceled download render as PAUSED (canceled + hasPartialData),
        // whose action button is pause/resume — so cancel showed "Paused"
        // and the next click restarted the transfer.
        aSetProgressBytesFn(p.receivedBytes, p.totalBytes, false);
      },
      this.#controller.signal,
    );
    this.#result = result;

    if (result.ok) {
      if (this.download) {
        details.set(this.download, {
          mirrorCount: this.#mirrors.length,
          usedMirrors: Object.keys(result.contributions).length,
          verified: result.verified,
          hashType: result.hashType,
        });
      }
      // Land a final 100%. Download._setBytes DISCARDS any update arriving
      // less than kProgressUpdateIntervalMs (400ms) after the previous one —
      // not just the speed calculation, currentBytes with it. Chunks off a
      // fast mirror finish well inside that window, so every report after the
      // first was being thrown away and currentBytes stuck at one chunk's
      // worth on a finished download.
      //
      // Waiting out the window costs 400ms once, at the end of a transfer
      // measured in megabytes, and only when there is a stale value to correct.
      const total = this.#file.size ?? 0;
      const sinceLast = Date.now() - this.#lastProgressAt;
      if (sinceLast < PROGRESS_THROTTLE_MS) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, PROGRESS_THROTTLE_MS - sinceLast + 20)
        );
      }
      aSetProgressBytesFn(total, total, false);
      return;
    }

    // Rejecting is how a saver reports failure; the Download object turns this
    // into an error state the panel renders.
    throw new Error(result.error ?? "Metalink download failed");
  }

  cancel(): void {
    this.#controller.abort();
  }

  /**
   * The saver-contract method Download.removePartialData and the panel's
   * cancel actually call. Its earlier name here (removePartialData) is not
   * part of the contract, so the call threw and hasPartialData never cleared.
   */
  async removeData(canRemoveFinalTarget = false): Promise<void> {
    if (this.download?.succeeded && !canRemoveFinalTarget) return;
    const target = this.download?.target.path;
    if (target) await IOUtils.remove(target).catch(() => {});
  }

  /**
   * Round-trips as a copy saver. A custom type would throw in
   * DownloadSaver.fromSerializable and break restoring downloads.json at
   * startup; degrading to a plain single-source download of the same URL is
   * the sane fallback, which is also why `source` is a real mirror rather than
   * the .meta4.
   */
  toSerializable(): string {
    return "copy";
  }

  getSha256Hash(): null {
    return null;
  }
}

export interface StartResult {
  download: DownloadLike;
  completion: Promise<SegmentedResult | null>;
}

/**
 * Create a Download backed by the segmented transfer, register it with the
 * downloads list so it shows up everywhere Firefox shows downloads, and start
 * it. Resolves as soon as it is registered; `completion` settles when the
 * transfer does.
 */
export async function startSegmentedDownload(
  file: MetalinkFile,
  mirrors: MetalinkUrl[],
  hash: MetalinkHash | undefined,
  targetPath: string,
): Promise<StartResult> {
  const saver = new MetalinkSaver(file, mirrors, hash);

  const download = await Downloads.createDownload({
    // A real mirror, not the .meta4: this is what the panel shows as the
    // source, and what a deserialised copy-saver would re-fetch.
    source: mirrors[0].url,
    target: targetPath,
  });

  // The swap the module comment explains — mirrors what Download.fromSerializable
  // does internally.
  download.saver = saver;
  saver.download = download;

  metalinkDownloads.add(download);
  details.set(download, {
    mirrorCount: mirrors.length,
    usedMirrors: 0,
    verified: false,
  });

  const list = await Downloads.getList(Downloads.ALL);
  await list.add(download);

  const completion = download.start()
    .then(() => saver.result)
    .catch(() => saver.result);

  return { download, completion };
}
