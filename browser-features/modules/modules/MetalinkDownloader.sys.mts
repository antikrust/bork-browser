/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Downloading a Metalink-described file: try mirrors in order, verify the
 * digest, fall through to the next mirror on either a transport failure or a
 * checksum mismatch.
 *
 * Downloads go through Downloads.sys.mjs rather than a private fetch loop so
 * they land in about:downloads like everything else — pause/resume, the
 * downloads panel, and the user's configured directory all come for free. The
 * cost is that we cannot pull byte ranges from several mirrors at once; that
 * would need a custom engine and is deliberately not attempted here.
 */

import type {
  MetalinkFile,
  MetalinkHash,
  MetalinkUrl,
} from "./Metalink.sys.mts";

const { Downloads } = ChromeUtils.importESModule(
  "resource://gre/modules/Downloads.sys.mjs",
) as {
  Downloads: {
    createDownload(opts: { source: unknown; target: unknown }): Promise<
      DownloadLike
    >;
    getList(kind: unknown): Promise<{ add(d: DownloadLike): Promise<void> }>;
    getPreferredDownloadsDirectory(): Promise<string>;
    ALL: unknown;
  };
};

const { DownloadPaths } = ChromeUtils.importESModule(
  "resource://gre/modules/DownloadPaths.sys.mjs",
) as {
  DownloadPaths: { createNiceUniqueFile(file: nsIFile): nsIFile };
};

interface DownloadLike {
  start(): Promise<void>;
  cancel(): Promise<void>;
  removePartialData(): Promise<void>;
  target: { path: string };
  error?: { message?: string } | null;
}

export interface MetalinkAttempt {
  url: string;
  ok: boolean;
  reason?: string;
}

export interface MetalinkDownloadResult {
  ok: boolean;
  /** Final on-disk path, present when ok. */
  path?: string;
  /** Which mirror actually served it. */
  mirror?: string;
  /** Whether a digest was checked, and against which algorithm. */
  verified: boolean;
  hashType?: string;
  /** Every mirror tried, in order, with why it failed. */
  attempts: MetalinkAttempt[];
  error?: string;
}

/**
 * nsICryptoHash algorithm constant for a Metalink hash type name.
 *
 * The generated xpcom typings declare these constants as optional, so each is
 * coalesced rather than returned directly — a missing constant would otherwise
 * make this return undefined and silently skip verification.
 */
function cryptoHashConstant(type: string): number | null {
  switch (type) {
    case "md5":
      return Ci.nsICryptoHash.MD5 ?? null;
    case "sha-1":
    case "sha1":
      return Ci.nsICryptoHash.SHA1 ?? null;
    case "sha-256":
    case "sha256":
      return Ci.nsICryptoHash.SHA256 ?? null;
    case "sha-384":
      return Ci.nsICryptoHash.SHA384 ?? null;
    case "sha-512":
    case "sha512":
      return Ci.nsICryptoHash.SHA512 ?? null;
    default:
      return null;
  }
}

/** nsICryptoHash.finish(false) hands back raw bytes in a JS string. */
function binaryToHex(binary: string): string {
  let hex = "";
  for (let i = 0; i < binary.length; i++) {
    hex += (binary.charCodeAt(i) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Digest a file on disk. Streams it — a Metalink download can easily be an
 * install image, and reading one into an ArrayBuffer to hash it would spike
 * memory by the size of the file.
 */
export function hashFile(path: string, type: string): string | null {
  const algo = cryptoHashConstant(type);
  if (algo === null) return null;

  let stream: nsIFileInputStream | null = null;
  try {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    if (!file.exists()) return null;

    stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(
      Ci.nsIFileInputStream,
    );
    // PR_RDONLY, default perms, no special behaviour.
    stream.init(file, 0x01, 0o444, 0);

    const hasher = Cc["@mozilla.org/security/hash;1"].createInstance(
      Ci.nsICryptoHash,
    );
    hasher.init(algo);
    // 0 = consume the whole stream.
    hasher.updateFromStream(stream, 0xffffffff);
    return binaryToHex(hasher.finish(false));
  } catch (e) {
    console.error("[Metalink] hashFile failed", e);
    return null;
  } finally {
    try {
      stream?.close();
    } catch {
      // closing a stream that never opened is not interesting
    }
  }
}

/**
 * Constant-time-ish comparison. Digest equality is not a secret-dependent
 * operation here (both sides are public values), so this is about correctness
 * — case and whitespace — rather than timing.
 */
function digestsMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

async function targetPathFor(name: string): Promise<string> {
  const dir = await Downloads.getPreferredDownloadsDirectory();
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(dir);
  // `name` has already been validated by isSafeMetalinkName; append() still
  // refuses separators, which is the second line of defence.
  file.append(name);
  // Never clobber: Firefox's own "file(1).ext" behaviour.
  return DownloadPaths.createNiceUniqueFile(file).path;
}

/**
 * Download `file` by trying `mirrors` in order.
 *
 * A checksum mismatch is treated exactly like a transport failure — the bytes
 * are discarded and the next mirror is tried. That matters: a mirror serving a
 * corrupt or tampered copy is the specific problem Metalink digests exist to
 * catch, and stopping at the first mismatch would leave the user with a bad
 * file and no automatic recourse.
 */
export async function downloadMetalinkFile(
  file: MetalinkFile,
  mirrors: MetalinkUrl[],
  hash: MetalinkHash | undefined,
  onProgress?: (mirror: string, index: number, total: number) => void,
): Promise<MetalinkDownloadResult> {
  const attempts: MetalinkAttempt[] = [];

  if (!mirrors.length) {
    return {
      ok: false,
      verified: false,
      attempts,
      error: "No usable mirrors in the Metalink document",
    };
  }

  for (let i = 0; i < mirrors.length; i++) {
    const mirror = mirrors[i];
    onProgress?.(mirror.url, i, mirrors.length);

    let download: DownloadLike | null = null;
    let path: string | null = null;
    try {
      path = await targetPathFor(file.name);
      download = await Downloads.createDownload({
        source: mirror.url,
        target: path,
      });
      const list = await Downloads.getList(Downloads.ALL);
      await list.add(download);
      await download.start();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      attempts.push({ url: mirror.url, ok: false, reason });
      // start() rejecting can still leave a .part file behind.
      try {
        await download?.removePartialData();
      } catch {
        // best effort
      }
      continue;
    }

    // Size check first — it is free and catches a truncated or wrong file
    // before we spend time hashing several hundred megabytes.
    if (file.size !== undefined) {
      let actual = -1;
      try {
        const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        f.initWithPath(path);
        actual = f.fileSize;
      } catch {
        actual = -1;
      }
      if (actual >= 0 && actual !== file.size) {
        attempts.push({
          url: mirror.url,
          ok: false,
          reason: `Wrong size: got ${actual} bytes, expected ${file.size}`,
        });
        await IOUtils.remove(path).catch(() => {});
        continue;
      }
    }

    if (!hash) {
      // Nothing to verify against. Still a success — plenty of real documents
      // list only mirrors — but the caller is told so it can say as much.
      attempts.push({ url: mirror.url, ok: true });
      return {
        ok: true,
        path,
        mirror: mirror.url,
        verified: false,
        attempts,
      };
    }

    const actualHash = hashFile(path, hash.type);
    if (actualHash && digestsMatch(actualHash, hash.value)) {
      attempts.push({ url: mirror.url, ok: true });
      return {
        ok: true,
        path,
        mirror: mirror.url,
        verified: true,
        hashType: hash.type,
        attempts,
      };
    }

    attempts.push({
      url: mirror.url,
      ok: false,
      reason: actualHash
        ? `${hash.type} mismatch`
        : `Could not compute ${hash.type}`,
    });
    // Do not leave a file that failed verification sitting in Downloads where
    // it looks indistinguishable from a good one.
    await IOUtils.remove(path).catch(() => {});
  }

  return {
    ok: false,
    verified: false,
    attempts,
    error: `All ${mirrors.length} mirror(s) failed`,
  };
}

/**
 * Fetch a Metalink document. Kept here rather than in the parser so the parser
 * stays pure and testable without network.
 *
 * `cache: "no-store"` for the same reason NoranekoUpdateChecker uses it: a
 * cached manifest can point at mirrors that have since been retired.
 */
export async function fetchMetalinkDocument(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Metalink fetch failed: HTTP ${res.status}`);
  }
  // A Metalink document is metadata; anything of this size is not one, and
  // parsing an unbounded response would be a trivial memory DoS.
  const MAX = 4 * 1024 * 1024;
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > MAX) {
    throw new Error(`Metalink document too large (${len} bytes)`);
  }
  const text = await res.text();
  if (text.length > MAX) {
    throw new Error("Metalink document too large");
  }
  return text;
}
