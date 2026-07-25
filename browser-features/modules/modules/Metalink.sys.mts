/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Metalink parsing — RFC 5854 (Metalink 4.0, `.meta4`) with a compatibility
 * path for the older Metalink 3.0 (`.metalink`, namespace
 * http://www.metalinker.org/), which is still what most published files in
 * the wild actually are.
 *
 * A Metalink document describes ONE OR MORE files as: a set of mirror URLs,
 * cryptographic hashes, a size, and assorted metadata. It is not BitTorrent —
 * a `<metaurl mediatype="torrent">` entry may point at a .torrent, but that is
 * one optional source among many and bork does not act on it (no torrent
 * engine in Gecko). We surface such entries so the user can hand the link to a
 * real torrent client, and otherwise download over plain HTTP(S)/FTP.
 *
 * Everything here is pure: XML string in, plain data out, no I/O. That keeps
 * the security-relevant validation (below) in one testable place.
 */

const METALINK4_NS = "urn:ietf:params:xml:ns:metalink";
const METALINK3_NS = "http://www.metalinker.org/";

/**
 * Schemes we are willing to fetch from. A Metalink document is untrusted input
 * from the network, so this is an allowlist, not a denylist: `file://` would
 * read the user's disk, `javascript:`/`data:` are code execution, and `chrome://`
 * reaches browser internals. RFC 5854 §4.2.6 only ever intends transfer
 * protocols here.
 */
const ALLOWED_SCHEMES = new Set(["http:", "https:", "ftp:"]);

/**
 * Hash algorithms we can actually verify, mapped to nsICryptoHash constants.
 * Names are the IANA registry values RFC 5854 §6 points at, lowercased.
 * md5/sha-1 are accepted for verification because real documents still carry
 * them, but they are never chosen when a stronger digest is present.
 */
export const HASH_ALGORITHMS: Record<string, string> = {
  "md5": "MD5",
  "sha-1": "SHA1",
  "sha1": "SHA1",
  "sha-224": "SHA224",
  "sha-256": "SHA256",
  "sha256": "SHA256",
  "sha-384": "SHA384",
  "sha-512": "SHA512",
  "sha512": "SHA512",
};

/** Strongest first — what verification should prefer. */
const HASH_STRENGTH = [
  "sha-512",
  "sha512",
  "sha-384",
  "sha-256",
  "sha256",
  "sha-224",
  "sha-1",
  "sha1",
  "md5",
];

export interface MetalinkUrl {
  url: string;
  /** RFC 5854: 1..999999, LOWER is preferred. Absent means "no preference". */
  priority?: number;
  /** ISO 3166-1 alpha-2, uppercased. */
  location?: string;
}

export interface MetalinkMetaUrl {
  url: string;
  /** "torrent" for BitTorrent; RFC 5854 requires the attribute. */
  mediatype: string;
  priority?: number;
  name?: string;
}

export interface MetalinkHash {
  /** Lowercased algorithm name, e.g. "sha-256". */
  type: string;
  /** Lowercase hex. */
  value: string;
}

export interface MetalinkPieces {
  /** Piece length in octets. */
  length: number;
  type: string;
  hashes: string[];
}

export interface MetalinkFile {
  name: string;
  size?: number;
  description?: string;
  version?: string;
  language: string[];
  os: string[];
  hashes: MetalinkHash[];
  urls: MetalinkUrl[];
  metaurls: MetalinkMetaUrl[];
  pieces?: MetalinkPieces;
}

export interface MetalinkDocument {
  files: MetalinkFile[];
  /** 4 or 3, whichever dialect was recognised. */
  version: 3 | 4;
  /** Non-fatal problems worth showing the user (dropped URLs, bad hashes). */
  warnings: string[];
}

export class MetalinkParseError extends Error {
  override name = "MetalinkParseError";
}

/**
 * RFC 5854 §4.1.2.1 makes this a MUST, and it is the one genuinely dangerous
 * field in the format: `name` becomes a filename on disk. A document saying
 * `../../.bashrc` or `/etc/cron.d/x` must be rejected outright rather than
 * sanitised, because a "cleaned" name silently downloads something to a path
 * the user did not agree to.
 *
 * Backslashes are rejected too. The RFC only names "/" but this has to be safe
 * on Windows, where `..\..\x` traverses just as well.
 */
export function isSafeMetalinkName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.startsWith("/") || name.startsWith("\\")) return false;
  if (name.includes("\0")) return false;
  // Any path segment that is exactly ".." — catches a/../../b as well as ../b.
  const segments = name.split(/[/\\]/);
  if (segments.some((s) => s === ".." || s === ".")) return false;
  // A drive-relative or UNC path on Windows.
  if (/^[a-zA-Z]:/.test(name)) return false;
  return true;
}

/** Reject anything we are not willing to open a connection to. */
export function isAllowedMetalinkUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}

function textOf(el: Element | null | undefined): string | undefined {
  const t = el?.textContent?.trim();
  return t ? t : undefined;
}

function intOf(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  // Deliberately strict: Number("") is 0 and parseInt("12abc") is 12, both of
  // which would turn malformed input into a plausible-looking number.
  if (!/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : undefined;
}

function childrenByTag(parent: Element, ns: string, tag: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS(ns, tag)).filter(
    (el) => el.parentNode === parent,
  );
}

/** Metalink 4.0 — the RFC 5854 shape. */
function parseV4File(el: Element, warnings: string[]): MetalinkFile | null {
  const name = el.getAttribute("name") ?? "";
  if (!isSafeMetalinkName(name)) {
    warnings.push(`Skipped a file with an unsafe name: ${JSON.stringify(name)}`);
    return null;
  }

  const urls: MetalinkUrl[] = [];
  for (const u of childrenByTag(el, METALINK4_NS, "url")) {
    const url = textOf(u);
    if (!url) continue;
    if (!isAllowedMetalinkUrl(url)) {
      warnings.push(`Dropped a mirror with an unsupported scheme: ${url}`);
      continue;
    }
    urls.push({
      url,
      priority: intOf(u.getAttribute("priority")),
      location: u.getAttribute("location")?.toUpperCase() || undefined,
    });
  }

  const metaurls: MetalinkMetaUrl[] = [];
  for (const m of childrenByTag(el, METALINK4_NS, "metaurl")) {
    const url = textOf(m);
    const mediatype = m.getAttribute("mediatype")?.trim();
    // mediatype is REQUIRED by the RFC; without it we cannot say what the
    // target even is, so it is not something to guess at.
    if (!url || !mediatype) continue;
    if (!isAllowedMetalinkUrl(url)) continue;
    metaurls.push({
      url,
      mediatype: mediatype.toLowerCase(),
      priority: intOf(m.getAttribute("priority")),
      name: m.getAttribute("name") || undefined,
    });
  }

  const hashes: MetalinkHash[] = [];
  for (const h of childrenByTag(el, METALINK4_NS, "hash")) {
    const type = h.getAttribute("type")?.trim().toLowerCase();
    const value = textOf(h)?.toLowerCase();
    if (!type || !value) continue;
    if (!/^[0-9a-f]+$/.test(value)) {
      warnings.push(`Ignored a ${type} hash that is not hexadecimal.`);
      continue;
    }
    hashes.push({ type, value });
  }

  let pieces: MetalinkPieces | undefined;
  const piecesEl = childrenByTag(el, METALINK4_NS, "pieces")[0];
  if (piecesEl) {
    const length = intOf(piecesEl.getAttribute("length"));
    const type = piecesEl.getAttribute("type")?.trim().toLowerCase();
    if (length && type) {
      const hashList = childrenByTag(piecesEl, METALINK4_NS, "hash")
        .map((h) => textOf(h)?.toLowerCase())
        .filter((v): v is string => !!v && /^[0-9a-f]+$/.test(v));
      if (hashList.length) pieces = { length, type, hashes: hashList };
    }
  }

  return {
    name,
    size: intOf(textOf(childrenByTag(el, METALINK4_NS, "size")[0])),
    description: textOf(childrenByTag(el, METALINK4_NS, "description")[0]),
    version: textOf(childrenByTag(el, METALINK4_NS, "version")[0]),
    language: childrenByTag(el, METALINK4_NS, "language")
      .map((l) => textOf(l)).filter((v): v is string => !!v),
    os: childrenByTag(el, METALINK4_NS, "os")
      .map((o) => textOf(o)).filter((v): v is string => !!v),
    hashes,
    urls,
    metaurls,
    pieces,
  };
}

/**
 * Metalink 3.0 — predates the RFC and is still the common case for `.metalink`
 * files. Shape differs enough to need its own path: files live under
 * <files>, mirrors under <resources>, and preference counts UP (0..100, higher
 * is better) rather than down.
 */
function parseV3File(el: Element, warnings: string[]): MetalinkFile | null {
  const name = el.getAttribute("name") ?? "";
  if (!isSafeMetalinkName(name)) {
    warnings.push(`Skipped a file with an unsafe name: ${JSON.stringify(name)}`);
    return null;
  }

  const urls: MetalinkUrl[] = [];
  const resources = childrenByTag(el, METALINK3_NS, "resources")[0];
  if (resources) {
    for (const u of childrenByTag(resources, METALINK3_NS, "url")) {
      const url = textOf(u);
      if (!url || !isAllowedMetalinkUrl(url)) continue;
      // v3 "preference" is 0..100 ascending. Invert into v4's descending
      // priority so the rest of the code only ever deals with one convention.
      const pref = intOf(u.getAttribute("preference"));
      urls.push({
        url,
        priority: pref === undefined ? undefined : Math.max(1, 101 - pref),
        location: u.getAttribute("location")?.toUpperCase() || undefined,
      });
    }
  }

  const hashes: MetalinkHash[] = [];
  const verification = childrenByTag(el, METALINK3_NS, "verification")[0];
  if (verification) {
    for (const h of childrenByTag(verification, METALINK3_NS, "hash")) {
      const type = h.getAttribute("type")?.trim().toLowerCase();
      const value = textOf(h)?.toLowerCase();
      if (!type || !value || !/^[0-9a-f]+$/.test(value)) continue;
      hashes.push({ type, value });
    }
  }

  return {
    name,
    size: intOf(textOf(childrenByTag(el, METALINK3_NS, "size")[0])),
    description: textOf(childrenByTag(el, METALINK3_NS, "description")[0]),
    version: textOf(childrenByTag(el, METALINK3_NS, "version")[0]),
    language: [
      textOf(childrenByTag(el, METALINK3_NS, "language")[0]),
    ].filter((v): v is string => !!v),
    os: [textOf(childrenByTag(el, METALINK3_NS, "os")[0])]
      .filter((v): v is string => !!v),
    hashes,
    urls,
    metaurls: [],
    pieces: undefined,
  };
}

/**
 * Parse a Metalink document. Throws MetalinkParseError on anything that is not
 * recognisably Metalink; returns a document with an empty `files` array if it
 * parsed but every file was rejected (the caller should treat that as a
 * failure to offer anything, not as a successful empty download).
 */
export function parseMetalink(xml: string): MetalinkDocument {
  const warnings: string[] = [];

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "application/xml");
  } catch (e) {
    throw new MetalinkParseError(
      `Could not parse as XML: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // DOMParser reports XML errors as a <parsererror> document rather than
  // throwing, so an unchecked parse silently yields a document with no files.
  if (doc.documentElement?.nodeName === "parsererror") {
    throw new MetalinkParseError(
      doc.documentElement.textContent?.trim().split("\n")[0] ||
        "Malformed XML",
    );
  }

  const root = doc.documentElement;
  if (!root) throw new MetalinkParseError("Empty document");

  if (root.namespaceURI === METALINK4_NS) {
    const files = Array.from(
      doc.getElementsByTagNameNS(METALINK4_NS, "file"),
    )
      .map((el) => parseV4File(el, warnings))
      .filter((f): f is MetalinkFile => f !== null);
    return { files, version: 4, warnings };
  }

  if (root.namespaceURI === METALINK3_NS) {
    const files = Array.from(
      doc.getElementsByTagNameNS(METALINK3_NS, "file"),
    )
      .map((el) => parseV3File(el, warnings))
      .filter((f): f is MetalinkFile => f !== null);
    return { files, version: 3, warnings };
  }

  throw new MetalinkParseError(
    `Not a Metalink document (root <${root.nodeName}> in namespace ` +
      `${root.namespaceURI ?? "none"})`,
  );
}

/**
 * Best hash to verify against: strongest algorithm we can actually compute.
 * Returns undefined when the document carries none we support, which is not an
 * error — plenty of real documents only list mirrors.
 */
export function strongestHash(file: MetalinkFile): MetalinkHash | undefined {
  for (const algo of HASH_STRENGTH) {
    const hit = file.hashes.find((h) => h.type === algo && HASH_ALGORITHMS[h.type]);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Mirrors in the order we should try them: explicit priority first (ascending,
 * per RFC 5854), then any without one. Ties are shuffled rather than left in
 * document order so that a document listing ten equal mirrors does not send
 * every bork user to whichever one happens to be first.
 */
export function orderMirrors(
  file: MetalinkFile,
  preferredLocation?: string,
): MetalinkUrl[] {
  const withIndex = file.urls.map((u, i) => ({ u, i, r: Math.random() }));
  withIndex.sort((a, b) => {
    // A mirror in the user's own country wins regardless of priority — it is
    // the single best predictor of throughput we have without probing.
    if (preferredLocation) {
      const aLocal = a.u.location === preferredLocation;
      const bLocal = b.u.location === preferredLocation;
      if (aLocal !== bLocal) return aLocal ? -1 : 1;
    }
    const ap = a.u.priority ?? Number.MAX_SAFE_INTEGER;
    const bp = b.u.priority ?? Number.MAX_SAFE_INTEGER;
    if (ap !== bp) return ap - bp;
    return a.r - b.r;
  });
  return withIndex.map((x) => x.u);
}
