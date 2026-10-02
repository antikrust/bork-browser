"use strict";
/**
 * Config storage, shared by the background script, the content script, the
 * blocked page and the options page.
 *
 * One record under one key: every consumer re-reads the whole thing on any
 * change anyway (a newly blocked domain has to be applied to links already on
 * screen), so per-key granularity would buy nothing and allow partial writes.
 */
globalThis.FKOF = globalThis.FKOF || {};
(function (FKOF) {
  const api = globalThis.browser ?? globalThis.chrome;
  const KEY = "config";

  const DEFAULTS = {
    enabled: true,

    /**
     * Keys of bundled outlets the user has let back in. Stored as an opt-out
     * list rather than an opt-in copy of the bundle, so an outlet gaining new
     * domains in a later version keeps working without the user re-blocking it.
     */
    allowed: [],

    /** Domains the user added: { domain, name, at (epoch ms), why }. */
    custom: [],

    /** Hide search results, feed posts and cards that link to a blocked domain. */
    hideCards: true,
    /** Intercept navigation and show the reasons page instead. */
    blockNav: true,
    /** Hover button on result cards. The right-click menu works either way. */
    showButton: true,

    stats: { blocked: 0, hidden: 0 },
  };

  function clone(value) {
    return typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  /** Fill in anything a stored config predates: a new key must never read as undefined. */
  function withDefaults(stored) {
    const out = clone(DEFAULTS);
    if (!stored || typeof stored !== "object") return out;
    for (const [k, v] of Object.entries(stored)) {
      if (!(k in out)) continue;
      if (v === null || v === undefined) continue;
      out[k] = Array.isArray(out[k]) && !Array.isArray(v) ? out[k] : v;
    }
    out.stats = Object.assign(clone(DEFAULTS.stats), stored.stats || {});
    return out;
  }

  async function load() {
    const got = await api.storage.local.get(KEY);
    return withDefaults(got && got[KEY]);
  }

  async function save(config) {
    await api.storage.local.set({ [KEY]: config });
    return config;
  }

  /**
   * Read-modify-write. Kept here so callers never race each other through a
   * get/set pair of their own — the content script writes from a click handler
   * while the options page may be open on the same data.
   */
  async function update(mutate) {
    const current = await load();
    const next = (await mutate(current)) || current;
    return save(next);
  }

  function onChange(callback) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[KEY]) return;
      callback(withDefaults(changes[KEY].newValue));
    });
  }

  FKOF.store = { DEFAULTS, load, save, update, onChange, withDefaults, clone };
})(globalThis.FKOF);
