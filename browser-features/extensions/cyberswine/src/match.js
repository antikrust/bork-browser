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

  function unwrap(href) {
    try {
      const url = new URL(href, "https://x.invalid/");
      for (const key of WRAPPED) {
        const value = url.searchParams.get(key);
        if (value && /^https?:\/\//i.test(value)) return value;
      }
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
      const url = new URL(unwrap(raw), base || "https://x.invalid/");
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
