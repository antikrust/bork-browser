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

/** Below this, connection setup costs more than parallelism saves. */
const MIN_SEGMENTED_SIZE = 4 * 1024 * 1024;
/** Mirrors hit at once. Above ~6 you mostly annoy mirror operators. */
const MAX_CONNECTIONS = 6;
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
/** A mirror that fails this many chunks is retired. */
const MAX_MIRROR_FAILURES = 2;

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
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(url, {
      headers: { Range: "bytes=0-0" },
      cache: "no-store",
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
  }
}

/** Fetch one chunk, validating that we got exactly the bytes we asked for. */
async function fetchChunk(
  url: string,
  chunk: Chunk,
): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { Range: `bytes=${chunk.start}-${chunk.end}` },
    cache: "no-store",
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
  const buf = new Uint8Array(await res.arrayBuffer());
  const expected = chunk.end - chunk.start + 1;
  if (buf.byteLength !== expected) {
    throw new Error(`got ${buf.byteLength} bytes, expected ${expected}`);
  }
  return buf;
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
    candidates.map(async (m) => ({ m, r: await probeRange(m.url, size) })),
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
  const failures = new Map<string, number>();
  const active = new Set<string>();
  let received = 0;
  let completed = 0;

  const writer = new OffsetWriter(targetPath, size);
  const workerCount = Math.min(usable.length, MAX_CONNECTIONS);

  const worker = async (mirror: MetalinkUrl): Promise<void> => {
    for (;;) {
      const chunk = queue.shift();
      if (!chunk) return;

      active.add(mirror.url);
      try {
        const bytes = await fetchChunk(mirror.url, chunk);
        await writer.write(chunk.start, bytes);
        received += bytes.byteLength;
        completed++;
        contributions[mirror.url] = (contributions[mirror.url] ?? 0) + 1;
        onProgress?.({
          receivedBytes: received,
          totalBytes: size,
          activeMirrors: [...active],
          completedChunks: completed,
          totalChunks: chunks.length,
        });
      } catch (e) {
        // Put it back for someone else and count this mirror's failure.
        queue.unshift(chunk);
        const n = (failures.get(mirror.url) ?? 0) + 1;
        failures.set(mirror.url, n);
        active.delete(mirror.url);
        if (n >= MAX_MIRROR_FAILURES) {
          retired.push(
            `${mirror.url} (${e instanceof Error ? e.message : String(e)})`,
          );
          return;
        }
        continue;
      }
      active.delete(mirror.url);
    }
  };

  try {
    await Promise.all(usable.slice(0, workerCount).map((m) => worker(m)));
  } finally {
    await writer.close();
  }

  if (queue.length > 0) {
    await IOUtils.remove(targetPath).catch(() => {});
    return {
      ok: false,
      verified: false,
      contributions,
      retiredMirrors: retired,
      error: `every mirror failed with ${queue.length} chunk(s) outstanding`,
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
