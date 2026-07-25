/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Metalink/HTTP — RFC 6249. The same information a `.meta4` carries, but
 * advertised in the response headers of an ordinary download:
 *
 *   Link: <http://mirror.example/f.iso>; rel=duplicate; pri=1; geo=de
 *   Link: <http://example/f.meta4>; rel=describedby; type="application/metalink4+xml"
 *   Digest: SHA-256=cRDtpNCeBiql5KOQsKVtrQ==
 *
 * No `.meta4` file is involved and the user never sees anything Metalink-shaped
 * — a plain download simply gains mirrors to fall back to and a digest to be
 * checked against. We observe responses and remember what we saw, keyed by URL,
 * so the download path can ask later.
 *
 * Note the Digest header carries BASE64 (RFC 3230), while Metalink/XML carries
 * lowercase hex (RFC 5854 §6). Everything is normalised to hex on the way in so
 * the verification code only ever deals with one encoding.
 */

export interface HttpMirror {
  url: string;
  /** RFC 6249 `pri`, 1..999999, lower preferred. */
  priority?: number;
  /** RFC 6249 `geo`, ISO 3166-1 alpha-2, uppercased. */
  location?: string;
}

export interface MetalinkHttpInfo {
  mirrors: HttpMirror[];
  /** Lowercase hex, normalised from the base64 the header carries. */
  digest?: { type: string; value: string };
  /** A `.meta4` describing this resource, from rel=describedby. */
  describedBy?: string;
  seen: number;
}

/**
 * Entries are only useful for the life of a download, and an unbounded map
 * keyed by URL is a memory leak on a long-running browser session.
 */
const MAX_ENTRIES = 200;
const MAX_AGE_MS = 10 * 60 * 1000;
const cache = new Map<string, MetalinkHttpInfo>();

/** RFC 3230 digest algorithm names -> Metalink/XML hash type names. */
const DIGEST_ALGORITHMS: Record<string, string> = {
  "md5": "md5",
  "sha": "sha-1",
  "sha-1": "sha-1",
  "sha-256": "sha-256",
  "sha-512": "sha-512",
};

function base64ToHex(b64: string): string | null {
  try {
    const binary = atob(b64.trim());
    let hex = "";
    for (let i = 0; i < binary.length; i++) {
      hex += (binary.charCodeAt(i) & 0xff).toString(16).padStart(2, "0");
    }
    return hex;
  } catch {
    return null;
  }
}

/**
 * Split a Link header field into its individual links.
 *
 * Cannot be a plain `split(",")`: a URI-Reference may contain a comma, and so
 * may a quoted parameter value. Track angle-bracket and quote depth instead.
 */
export function splitLinkHeader(header: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuotes = false;
  let current = "";
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (inQuotes) {
      if (c === "\\" && i + 1 < header.length) {
        current += c + header[++i];
        continue;
      }
      if (c === '"') inQuotes = false;
      current += c;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      current += c;
      continue;
    }
    if (c === "<") depth++;
    if (c === ">") depth--;
    if (c === "," && depth <= 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim()) out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

export interface ParsedLink {
  url: string;
  params: Record<string, string>;
}

/** Parse one link value: `<uri>; rel=duplicate; pri=1`. */
export function parseLinkValue(value: string): ParsedLink | null {
  const m = /^<([^>]*)>\s*(.*)$/s.exec(value.trim());
  if (!m) return null;
  const url = m[1].trim();
  if (!url) return null;

  const params: Record<string, string> = {};
  // Parameters are `; name=value` or `; name="quoted value"`.
  const re = /;\s*([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;,\s]*)/g;
  let p: RegExpExecArray | null;
  while ((p = re.exec(m[2])) !== null) {
    let v = p[2];
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    params[p[1].toLowerCase()] = v;
  }
  return { url, params };
}

/**
 * Pull Metalink/HTTP information out of a response's headers.
 * Returns null when the response advertises nothing Metalink-ish.
 */
export function parseMetalinkHeaders(
  getHeader: (name: string) => string | null,
  baseUrl: string,
): MetalinkHttpInfo | null {
  const mirrors: HttpMirror[] = [];
  let describedBy: string | undefined;

  const linkHeader = getHeader("Link");
  if (linkHeader) {
    for (const raw of splitLinkHeader(linkHeader)) {
      const link = parseLinkValue(raw);
      if (!link) continue;

      // Resolve against the response URL — RFC 8288 allows relative refs.
      let abs: string;
      try {
        abs = new URL(link.url, baseUrl).href;
      } catch {
        continue;
      }
      // Only ever fetch over transfer protocols; see Metalink.sys.mts.
      if (!/^(https?|ftp):/.test(abs)) continue;

      const rel = link.params["rel"]?.toLowerCase();
      if (rel === "duplicate") {
        const pri = link.params["pri"];
        mirrors.push({
          url: abs,
          priority: pri && /^\d+$/.test(pri) ? Number(pri) : undefined,
          location: link.params["geo"]?.toUpperCase(),
        });
      } else if (rel === "describedby") {
        const type = link.params["type"]?.toLowerCase();
        if (
          type === "application/metalink4+xml" ||
          type === "application/metalink+xml"
        ) {
          describedBy = abs;
        }
      }
    }
  }

  let digest: { type: string; value: string } | undefined;
  const digestHeader = getHeader("Digest");
  if (digestHeader) {
    // `Digest: SHA-256=abc==, MD5=def==` — take the strongest we understand.
    const order = ["sha-512", "sha-256", "sha-1", "md5"];
    const found: Record<string, string> = {};
    for (const part of digestHeader.split(",")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const algo = part.slice(0, eq).trim().toLowerCase();
      const value = part.slice(eq + 1).trim();
      const mapped = DIGEST_ALGORITHMS[algo];
      if (!mapped || !value) continue;
      const hex = base64ToHex(value);
      if (hex) found[mapped] = hex;
    }
    for (const algo of order) {
      if (found[algo]) {
        digest = { type: algo, value: found[algo] };
        break;
      }
    }
  }

  if (!mirrors.length && !digest && !describedBy) return null;
  return { mirrors, digest, describedBy, seen: Date.now() };
}

function prune(): void {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.seen > MAX_AGE_MS) cache.delete(k);
  }
  // Map preserves insertion order, so the oldest keys are first.
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** What we recorded for `url`, if anything is still cached. */
export function lookupMetalinkHttp(url: string): MetalinkHttpInfo | undefined {
  const hit = cache.get(url);
  if (!hit) return undefined;
  if (Date.now() - hit.seen > MAX_AGE_MS) {
    cache.delete(url);
    return undefined;
  }
  return hit;
}

const PREF_ENABLED = "bork.metalink.http.enabled";
const PREF_METALINK_ENABLED = "bork.metalink.enabled";

const METALINK_TYPES = new Set([
  "application/metalink4+xml",
  "application/metalink+xml",
]);

/**
 * URLs we are fetching ourselves. fetchMetalinkDocument goes through necko like
 * anything else, so without this the observer below would cancel our own fetch
 * of the document we are trying to read.
 */
const selfFetching = new Set<string>();

/** Recently intercepted, so the two entry points cannot both act on one URL. */
const handled = new Map<string, number>();
const HANDLED_TTL_MS = 30_000;

export function beginSelfFetch(url: string): void {
  selfFetching.add(url);
}
export function endSelfFetch(url: string): void {
  selfFetching.delete(url);
}

/**
 * True once per URL per 30s. Both the nsIContentHandler factory and the
 * response observer can see the same document; whichever gets there first wins.
 */
export function claimMetalinkUrl(url: string): boolean {
  const now = Date.now();
  for (const [k, t] of handled) {
    if (now - t > HANDLED_TTL_MS) handled.delete(k);
  }
  if (handled.has(url)) return false;
  handled.set(url, now);
  return true;
}

function looksLikeMetalink(url: string, contentType: string): boolean {
  if (METALINK_TYPES.has(contentType)) return true;
  // Fall back to the extension. MirrorBrain and friends get the type right, but
  // plenty of mirrors serve .meta4 as application/octet-stream.
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.endsWith(".meta4") || path.endsWith(".metalink");
  } catch {
    return false;
  }
}

const responseObserver = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
  observe(subject: nsISupports, topic: string): void {
    if (topic !== "http-on-examine-response") return;
    try {
      // nsISupports.QueryInterface is optional in the generated typings, and
      // observers do get handed subjects that are not channels at all.
      const qi = (subject as { QueryInterface?: (iid: unknown) => unknown })
        .QueryInterface;
      if (typeof qi !== "function") return;
      const channel = qi.call(subject, Ci.nsIHttpChannel) as nsIHttpChannel;
      const url = channel.URI?.spec;
      if (!url) return;

      const getHeader = (name: string): string | null => {
        try {
          return channel.getResponseHeader(name) || null;
        } catch {
          // Gecko throws NS_ERROR_NOT_AVAILABLE for an absent header rather
          // than returning empty, so this is the normal "not present" path.
          return null;
        }
      };

      // --- Metalink document interception ---
      //
      // This, not the nsIContentHandler factory, is what actually catches real
      // Metalink downloads. Every server that publishes them sends
      // `Content-Disposition: attachment` (they ARE downloads), and that routes
      // Gecko straight to nsIExternalHelperAppService without ever consulting
      // the `@mozilla.org/uriloader/content-handler;1?type=` contract. The
      // factory therefore only ever fired for documents served inline, which no
      // real mirror does — LibreOffice's .meta4 sails right past it.
      //
      // Examining the response catches it regardless of disposition.
      if (
        !selfFetching.has(url) &&
        Services.prefs.getBoolPref(PREF_METALINK_ENABLED, true) &&
        looksLikeMetalink(url, channel.contentType ?? "")
      ) {
        // Only top-level loads. A page embedding a .meta4 in a frame should not
        // be able to pop a download picker at the user.
        let isDocument = false;
        try {
          isDocument = channel.loadInfo?.externalContentPolicyType ===
            Ci.nsIContentPolicy.TYPE_DOCUMENT;
        } catch {
          isDocument = false;
        }
        if (isDocument && claimMetalinkUrl(url)) {
          channel.cancel(Cr.NS_BINDING_ABORTED);
          const svc = ChromeUtils.importESModule(
            "resource://noraneko/modules/MetalinkService.sys.mjs",
          ) as { openMetalinkUrl(u: string): Promise<void> };
          svc.openMetalinkUrl(url).catch((e) =>
            console.error("[MetalinkHttp] open", e)
          );
          return;
        }
      }

      if (!Services.prefs.getBoolPref(PREF_ENABLED, true)) return;

      // Cheap bail-out before any parsing: the vast majority of responses
      // carry neither header, and this observer sees every single one.
      if (!getHeader("Link") && !getHeader("Digest")) return;

      const info = parseMetalinkHeaders(getHeader, url);
      if (!info) return;
      cache.set(url, info);
      prune();
    } catch (e) {
      console.error("[MetalinkHttp]", e);
    }
  },
};

let registered = false;

/** Start observing. Idempotent. */
export function startMetalinkHttp(): void {
  if (registered) return;
  Services.obs.addObserver(responseObserver, "http-on-examine-response", false);
  registered = true;
}

/**
 * Stop observing and drop the cache. The panel-sidebar UA observer this is
 * modelled on registers at import time and never unregisters; doing it
 * properly here means the feature can actually be turned off.
 */
export function stopMetalinkHttp(): void {
  if (!registered) return;
  try {
    Services.obs.removeObserver(responseObserver, "http-on-examine-response");
  } catch (e) {
    console.error("[MetalinkHttp] removeObserver", e);
  }
  registered = false;
  cache.clear();
}
