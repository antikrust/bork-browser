/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Segmented multi-mirror downloading — the thing Metalink exists for.
 *
 * The file is cut into chunks and pulled from several mirrors at once with HTTP
 * Range requests, then reassembled on disk. Chunks come off a shared work queue
 * rather than being pre-assigned, so a fast mirror simply takes more of them and
 * one slow mirror cannot hold up the whole transfer.
 *
 * Written directly against fetch + nsIFileOutputStream. Every off-the-shelf
 * multipart downloader assumes Node's fs/http, neither of which exists in
 * privileged chrome, so adapting one would be more work and more risk than this.
 *
 * Not routed through Downloads.sys.mjs: that owns its own transfer, and the
 * whole point here is to run several of our own. The trade-off is that these do
 * not appear in about:downloads — see downloadMetalinkFile in
 * MetalinkDownloader.sys.mts for the single-mirror path that does.
 */

import type {
  MetalinkFile,
  MetalinkHash,
  MetalinkUrl,
} from "./Metalink.sys.mts";
import { hashFile } from "./MetalinkDownloader.sys.mts";

// Not globals in .sys.mjs scope — they live in Timer.sys.mjs.
const { setTimeout, clearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs",
) as {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
};

/** Below this, connection setup costs more than parallelism saves. */
const MIN_SEGMENTED_SIZE = 4 * 1024 * 1024;
/** Mirrors hit at once. Above ~6 you mostly annoy mirror operators. */
const MAX_CONNECTIONS = 6;
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
/**
 * A mirror gets one chance. Retrying a bad one costs a whole chunk's timeout
 * and the queue is shared anyway — another mirror picks the chunk up
 * immediately, so there is nothing to gain by waiting on this one.
 */
const MAX_MIRROR_FAILURES = 1;

/**
 * Ceilings on a single request. Without them a mirror that accepts the
 * connection and then stalls holds its worker until the OS gives up, which is
 * how one bad mirror drags a whole transfer: the other workers finish the queue
 * and then wait on it.
 *
 * The probe is short because it asks for one byte. The chunk ceiling is a
 * stall detector, not a speed limit — it is reset by progress, so a slow but
 * live mirror is left alone and only a silent one is dropped.
 */
const PROBE_TIMEOUT_MS = 4000;
const CHUNK_STALL_MS = 10000;

/**
 * A signal that aborts when the caller aborts, or when `ms` passes without a
 * bump(). Hand-rolled because AbortSignal.timeout/any are window-scoped and
 * throw "Could not find window" in a .sys.mjs module.
 */
function stallGuard(ms: number, parent?: AbortSignal) {
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(), ms);
  const onParent = () => ctl.abort();
  parent?.addEventListener("abort", onParent);
  return {
    signal: ctl.signal,
    bump() {
      clearTimeout(timer);
      timer = setTimeout(() => ctl.abort(), ms);
    },
    done() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParent);
    },
  };
}

/** Typed as optional by the generated defs; it is a fixed XPCOM constant (0). */
const SEEK_SET = Ci.nsISeekableStream.NS_SEEK_SET ?? 0;

export interface SegmentedProgress {
  receivedBytes: number;
  totalBytes: number;
  /** Mirrors currently transferring. */
  activeMirrors: string[];
  completedChunks: number;
  totalChunks: number;
}

export interface SegmentedResult {
  ok: boolean;
  path?: string;
  verified: boolean;
  hashType?: string;
  /** Mirrors that actually contributed bytes, with how many chunks each served. */
  contributions: Record<string, number>;
  retiredMirrors: string[];
  error?: string;
  /** True when we fell back to a single stream (no ranges, or file too small). */
  fellBackToSingle?: boolean;
  /** True when the caller aborted; not a failure to report as one. */
  cancelled?: boolean;
}

interface Chunk {
  index: number;
  start: number;
  /** Inclusive, per RFC 7233. */
  end: number;
}

/**
 * Serialises writes. Several workers finish chunks concurrently but they share
 * one file handle, and therefore one seek position — writing from two of them at
 * once would interleave at the wrong offsets.
 */
class OffsetWriter {
  #stream: nsIFileOutputStream;
  #seekable: nsISeekableStream;
  #binary: nsIBinaryOutputStream;
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string, size: number) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);

    this.#stream = Cc["@mozilla.org/network/file-output-stream;1"]
      .createInstance(Ci.nsIFileOutputStream);
    // PR_WRONLY | PR_CREATE_FILE — deliberately NOT PR_TRUNCATE beyond the
    // initial setup, since workers write out of order.
    this.#stream.init(file, 0x02 | 0x08, 0o644, 0);

    // QueryInterface is optional in the generated typings.
    const qi = (this.#stream as unknown as {
      QueryInterface: (iid: unknown) => unknown;
    }).QueryInterface;
    this.#seekable = qi.call(
      this.#stream,
      Ci.nsISeekableStream,
    ) as nsISeekableStream;
    // Size the file up front so seeking past the current end is well defined.
    if (size > 0) {
      this.#seekable.seek(SEEK_SET, size);
      this.#seekable.setEOF();
    }

    this.#binary = Cc["@mozilla.org/binaryoutputstream;1"]
      .createInstance(Ci.nsIBinaryOutputStream);
    this.#binary.setOutputStream(this.#stream);
  }

  write(offset: number, bytes: Uint8Array): Promise<void> {
    this.#tail = this.#tail.then(() => {
      this.#seekable.seek(SEEK_SET, offset);
      // writeByteArray takes a typed array in modern Gecko; the generated
      // typing still says number[].
      this.#binary.writeByteArray(bytes as unknown as number[]);
    });
    return this.#tail;
  }

  async close(): Promise<void> {
    await this.#tail;
    try {
      this.#binary.close();
    } catch {
      // fall through to closing the underlying stream
    }
    try {
      this.#stream.close();
    } catch {
      // already closed
    }
  }
}

function planChunks(size: number, pieceLength?: number): Chunk[] {
  let chunkSize = DEFAULT_CHUNK_SIZE;
  // Align to whole pieces when the document carries piece hashes, so each chunk
  // can be verified the moment it lands instead of only at the end.
  if (pieceLength && pieceLength > 0) {
    const multiple = Math.max(1, Math.round(chunkSize / pieceLength));
    chunkSize = multiple * pieceLength;
  }
  const chunks: Chunk[] = [];
  for (let start = 0, i = 0; start < size; start += chunkSize, i++) {
    chunks.push({
      index: i,
      start,
      end: Math.min(start + chunkSize, size) - 1,
    });
  }
  return chunks;
}

/**
 * Does this mirror serve byte ranges, and does it agree about the file?
 * A mirror that ignores Range returns 200 with the whole body, which would
 * silently corrupt the assembly if we wrote it at a chunk offset.
 */
async function probeRange(
  url: string,
  size: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; reason?: string }> {
  const guard = stallGuard(PROBE_TIMEOUT_MS, signal);
  try {
    const res = await fetch(url, {
      headers: { Range: "bytes=0-0" },
      cache: "no-store",
      signal: guard.signal,
    });
    if (res.status !== 206) {
      // Drain so the connection can be reused/closed cleanly.
      await res.arrayBuffer().catch(() => undefined);
      return { ok: false, reason: `no range support (HTTP ${res.status})` };
    }
    const cr = res.headers.get("content-range") ?? "";
    const total = /\/(\d+)\s*$/.exec(cr)?.[1];
    await res.arrayBuffer().catch(() => undefined);
    if (total && Number(total) !== size) {
      return {
        ok: false,
        reason: `size mismatch (mirror says ${total}, metalink says ${size})`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    guard.done();
  }
}

/** Fetch one chunk, validating that we got exactly the bytes we asked for. */
async function fetchChunk(
  url: string,
  chunk: Chunk,
  signal?: AbortSignal,
  onBytes?: (soFar: number) => void,
): Promise<Uint8Array> {
  // A stall clock rather than a total deadline: every arriving block pushes it
  // out, so a slow mirror finishes and a silent one is cut loose in seconds.
  const guard = stallGuard(CHUNK_STALL_MS, signal);
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=${chunk.start}-${chunk.end}` },
      cache: "no-store",
      signal: guard.signal,
    });
    if (res.status !== 206) {
      throw new Error(`expected 206, got ${res.status}`);
    }
  // Trusting Content-Range rather than just the length stops a mirror handing
  // back a valid-length slice of the WRONG offset, which would assemble into a
  // corrupt file that only the final hash would catch.
    const cr = res.headers.get("content-range") ?? "";
    const m = /bytes\s+(\d+)-(\d+)\//.exec(cr);
    if (!m || Number(m[1]) !== chunk.start || Number(m[2]) !== chunk.end) {
      throw new Error(`content-range mismatch: ${cr || "(absent)"}`);
    }

    const expected = chunk.end - chunk.start + 1;
    const buf = new Uint8Array(expected);
    let at = 0;
    const reader = res.body?.getReader();
    if (!reader) {
      const whole = new Uint8Array(await res.arrayBuffer());
      if (whole.byteLength !== expected) {
        throw new Error(`got ${whole.byteLength} bytes, expected ${expected}`);
      }
      return whole;
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      guard.bump();
      if (at + value.byteLength > expected) {
        throw new Error("mirror sent more than the range asked for");
      }
      buf.set(value, at);
      at += value.byteLength;
      onBytes?.(at);
    }
    if (at !== expected) {
      throw new Error(`got ${at} bytes, expected ${expected}`);
    }
    return buf;
  } finally {
    guard.done();
  }
}

/**
 * Download `file` by pulling chunks from `mirrors` in parallel.
 *
 * Falls back to a plain single-stream download when the file is small, its size
 * is unknown, or no mirror supports ranges — callers get a normal result either
 * way, with fellBackToSingle set.
 */
export async function downloadSegmented(
  file: MetalinkFile,
  mirrors: MetalinkUrl[],
  hash: MetalinkHash | undefined,
  targetPath: string,
  onProgress?: (p: SegmentedProgress) => void,
  signal?: AbortSignal,
): Promise<SegmentedResult> {
  const contributions: Record<string, number> = {};
  const retired: string[] = [];

  const size = file.size;
  if (!size || size < MIN_SEGMENTED_SIZE || mirrors.length === 0) {
    return {
      ok: false,
      verified: false,
      contributions,
      retiredMirrors: retired,
      fellBackToSingle: true,
      error: !size
        ? "no size in the Metalink document"
        : "file too small to segment",
    };
  }

  // Probe mirrors in parallel; keep the ones that can actually serve ranges.
  const candidates = mirrors.slice(0, MAX_CONNECTIONS * 2);
  const probes = await Promise.all(
    candidates.map(async (m) => ({ m, r: await probeRange(m.url, size, signal) })),
  );
  const usable = probes.filter((p) => p.r.ok).map((p) => p.m);
  for (const p of probes) {
    if (!p.r.ok) retired.push(`${p.m.url} (${p.r.reason})`);
  }

  if (usable.length === 0) {
    return {
      ok: false,
      verified: false,
      contributions,
      retiredMirrors: retired,
      fellBackToSingle: true,
      error: "no mirror supports byte ranges",
    };
  }

  const chunks = planChunks(size, file.pieces?.length);
  const queue: Chunk[] = [...chunks];
  /** Handed to a worker, not yet written. */
  const pending = new Map<number, Chunk>();
  /** Written. A chunk can be fetched twice (see racing below); only one wins. */
  const done = new Set<number>();
  const failures = new Map<string, number>();
  const active = new Set<string>();
  let received = 0;
  let completed = 0;
  /**
   * Bytes arrived for chunks still in flight, so the bar moves continuously
   * instead of jumping once per 8MB chunk — on a slow mirror that looked like
   * a stalled download, and made a cancel look like it had done nothing.
   * Racing copies are excluded: they would double-count against the winner.
   */
  const inflight = new Map<number, number>();
  const report = () => {
    let live = 0;
    for (const n of inflight.values()) live += n;
    onProgress?.({
      receivedBytes: Math.min(received + live, size),
      totalBytes: size,
      activeMirrors: [...active],
      completedChunks: completed,
      totalChunks: chunks.length,
    });
  };

  const writer = new OffsetWriter(targetPath, size);
  const workerCount = Math.min(usable.length, MAX_CONNECTIONS);
  // Probed good but not given a starting slot. A worker whose mirror dies takes
  // one of these instead of ending, so a bad mirror costs a retry, not a
  // connection for the rest of the transfer.
  const spares: MetalinkUrl[] = usable.slice(workerCount);

  const delay = (ms: number) =>
    new Promise<void>((r) => setTimeout(() => r(), ms));

  // Aborted the moment the last chunk is written, so a mirror still holding a
  // superseded request is dropped instead of keeping the whole transfer waiting
  // on its stall timeout. Also mirrors the caller's cancel.
  const opCtl = new AbortController();
  const onCallerAbort = () => opCtl.abort();
  signal?.addEventListener("abort", onCallerAbort);
  const opSignal = opCtl.signal;

  const worker = async (start: MetalinkUrl): Promise<void> => {
    let mirror = start;
    for (;;) {
      if (signal?.aborted) return;
      if (done.size === chunks.length) return;

      let chunk = queue.shift();
      let racing = false;

      if (!chunk) {
        // Queue empty but work outstanding: race a chunk someone else is
        // already on rather than idling. A mirror that accepted the request and
        // went quiet would otherwise hold the whole transfer for its full stall
        // timeout while everyone else sat done — first copy to arrive wins.
        const candidate = [...pending.values()].find((c) => !done.has(c.index));
        if (!candidate) {
          await delay(50);
          continue;
        }
        chunk = candidate;
        racing = true;
      } else {
        pending.set(chunk.index, chunk);
      }

      active.add(mirror.url);
      try {
        const bytes = await fetchChunk(
          mirror.url,
          chunk,
          opSignal,
          racing ? undefined : (soFar) => {
            inflight.set(chunk.index, soFar);
            report();
          },
        );
        if (!done.has(chunk.index)) {
          await writer.write(chunk.start, bytes);
          done.add(chunk.index);
          pending.delete(chunk.index);
          // Everything is on disk; stop anyone still waiting on bytes we no
          // longer need.
          if (done.size === chunks.length) opCtl.abort();
          received += bytes.byteLength;
          completed++;
          inflight.delete(chunk.index);
          contributions[mirror.url] = (contributions[mirror.url] ?? 0) + 1;
          report();
        }
      } catch (e) {
        // A lost race is not a failure — the winner already wrote it.
        if (!done.has(chunk.index) && !racing) {
          queue.unshift(chunk);
          pending.delete(chunk.index);
        }
        inflight.delete(chunk.index);
        active.delete(mirror.url);
        if (signal?.aborted) return;
        // Cut loose after completion, or beaten to this chunk: neither is the
        // mirror's fault, so do not hold it against it.
        if (done.size === chunks.length) return;
        if (done.has(chunk.index)) continue;

        const n = (failures.get(mirror.url) ?? 0) + 1;
        failures.set(mirror.url, n);
        if (n >= MAX_MIRROR_FAILURES) {
          retired.push(
            `${mirror.url} (${e instanceof Error ? e.message : String(e)})`,
          );
          const spare = spares.shift();
          if (!spare) return;
          mirror = spare;
        }
        continue;
      }
      active.delete(mirror.url);
    }
  };

  try {
    await Promise.all(usable.slice(0, workerCount).map((m) => worker(m)));
  } finally {
    signal?.removeEventListener("abort", onCallerAbort);
    opCtl.abort();
    await writer.close();
  }

  if (signal?.aborted) {
    await IOUtils.remove(targetPath).catch(() => {});
    return {
      ok: false,
      verified: false,
      contributions,
      retiredMirrors: retired,
      cancelled: true,
      error: "cancelled",
    };
  }

  if (done.size !== chunks.length) {
    await IOUtils.remove(targetPath).catch(() => {});
    return {
      ok: false,
      verified: false,
      contributions,
      retiredMirrors: retired,
      error:
        `every mirror failed with ${chunks.length - done.size} chunk(s) outstanding`,
    };
  }

  if (!hash) {
    return {
      ok: true,
      path: targetPath,
      verified: false,
      contributions,
      retiredMirrors: retired,
    };
  }

  const actual = hashFile(targetPath, hash.type);
  if (actual && actual.toLowerCase() === hash.value.toLowerCase()) {
    return {
      ok: true,
      path: targetPath,
      verified: true,
      hashType: hash.type,
      contributions,
      retiredMirrors: retired,
    };
  }

  // Assembled from several sources, so a mismatch means one of them served bad
  // bytes and we cannot tell which. Discard rather than keep a file that looks
  // downloaded; the caller can retry on a single mirror.
  await IOUtils.remove(targetPath).catch(() => {});
  return {
    ok: false,
    verified: false,
    contributions,
    retiredMirrors: retired,
    error: actual
      ? `${hash.type} mismatch after assembly`
      : `could not compute ${hash.type}`,
  };
}
