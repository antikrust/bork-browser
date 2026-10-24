"use strict";
/**
 * Domain matching. No DOM, no storage — the part that decides whether a link
 * is one of theirs, kept separate from everything that touches a page.
 */
globalThis.FKOF = globalThis.FKOF || {};
(function (FKOF) {
  /** Lowercase, drop a trailing dot and a leading www. — nothing more clever. */
  function normalizeHost(host) {
    return String(host ?? "")
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "");
  }

  /**
   * Query parameters that carry a real destination. Aggregators and social
   * sites wrap outbound links, so the visible href is theirs and the article
   * underneath is the one worth judging — Google News is the obvious case.
   */
  const WRAPPED = ["url", "u", "q", "target", "redirect", "to"];

  /**
   * AMP addresses carry the publisher in the PATH, not a parameter, and they
   * are what Google hands phones: its own cache (google.com/amp/s/host/...)
   * and the AMP project's (host-with-dashes.cdn.ampproject.org/c/s/host/...).
   * A desktop sees the publisher's own link; a phone sees one of these, so
   * without this a blocked outlet read as Google on mobile and stayed up.
   */
  const GOOGLE_AMP = /^\/amp\/(s\/)?([^/?#]+)(\/[^?#]*)?/i;
  const AMP_CACHE = /^\/[a-z]\/(s\/)?([^/?#]+)(\/[^?#]*)?/i;

  function unwrapAmp(url) {
    const host = url.hostname.toLowerCase();
    let m = null;
    if (/(^|\.)google\.[a-z.]+$/.test(host)) m = GOOGLE_AMP.exec(url.pathname);
    else if (host.endsWith(".cdn.ampproject.org")) m = AMP_CACHE.exec(url.pathname);
    if (!m || !m[2].includes(".")) return null;
    return `${m[1] ? "https" : "http"}://${m[2]}${m[3] || "/"}`;
  }

  function unwrap(href, base) {
    try {
      // The page's own address as the base: Google's AMP links are often
      // relative ("/amp/s/host/..."), and only the base says they are Google's.
      const url = new URL(href, base || "https://x.invalid/");
      for (const key of WRAPPED) {
        const value = url.searchParams.get(key);
        if (value && /^https?:\/\//i.test(value)) return value;
      }
      const amp = unwrapAmp(url);
      if (amp) return amp;
    } catch {
      // A malformed href is simply not a wrapper.
    }
    return href;
  }

  /** Hostname of a link, or "" for anything that is not an ordinary web link. */
  function hostOf(href, base) {
    if (!href) return "";
    const raw = String(href);
    if (/^(javascript|mailto|tel|data|blob|about|chrome|moz-extension):/i.test(raw)) {
      return "";
    }
    try {
      const url = new URL(unwrap(raw, base), base || "https://x.invalid/");
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      return normalizeHost(url.hostname);
    } catch {
      return "";
    }
  }

  /**
   * Build the lookup once per config change: a Map from domain to entry, which
   * the walk below probes for the host and each of its parent domains. A page
   * can carry a few thousand links, so this stays a hash lookup rather than a
   * scan of the blocklist per link.
   */
  function buildIndex(config, outlets) {
    const index = new Map();
    const allowed = new Set(config.allowed || []);

    for (const outlet of outlets || []) {
      if (allowed.has(outlet.key)) continue;
      for (const domain of outlet.domains) {
        index.set(normalizeHost(domain), outlet);
      }
    }

    for (const entry of config.custom || []) {
      const domain = normalizeHost(entry && entry.domain);
      if (!domain) continue;
      index.set(domain, {
        key: `custom:${domain}`,
        name: entry.name || domain,
        domains: [domain],
        custom: true,
        note: entry.note || entry.why || "",
        at: entry.at || 0,
      });
    }

    return index;
  }

  /**
   * Match the host or any parent domain of it: news.dailymail.co.uk is theirs
   * too. Walks label by label rather than doing suffix string comparisons, so
   * "notthedailymail.co.uk" cannot match "dailymail.co.uk".
   */
  function lookup(host, index) {
    const clean = normalizeHost(host);
    if (!clean || !index || index.size === 0) return null;

    let candidate = clean;
    for (;;) {
      const hit = index.get(candidate);
      if (hit) return hit;
      const dot = candidate.indexOf(".");
      if (dot === -1) return null;
      candidate = candidate.slice(dot + 1);
      // A bare public suffix cannot be a match worth making.
      if (candidate.indexOf(".") === -1) return null;
    }
  }

  /** Entry for a link's href, or null. */
  function lookupHref(href, base, index) {
    return lookup(hostOf(href, base), index);
  }

  FKOF.match = { normalizeHost, unwrap, hostOf, buildIndex, lookup, lookupHref };
})(globalThis.FKOF);
