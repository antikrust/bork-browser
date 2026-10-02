"use strict";
/**
 * Config storage, shared by the content script, the options page and the popup.
 *
 * One record under one key rather than a key per setting: the content script
 * reloads the whole config on any change anyway (a changed word rule has to be
 * re-applied to messages already on screen), so per-key granularity would buy
 * nothing and make partial writes possible.
 *
 * chrome.storage.local, not .sync: a blocklist is long, personal, and grows
 * fast — sync quota is 100KB with an 8KB per-item cap, which a few hundred
 * blocked names plus rules can reach.
 */
globalThis.YTCT = globalThis.YTCT || {};
(function (YTCT) {
  const api = globalThis.browser ?? globalThis.chrome;
  const KEY = "config";

  /** The starting blocklist as blocklist entries. No date: nothing happened. */
  function shippedChannels() {
    return (YTCT.shippedChannels || []).map((name) => ({
      name,
      at: 0,
      why: "shipped with the extension",
    }));
  }

  const DEFAULTS = {
    enabled: true,

    /** Word rules that hide the offending MESSAGE. Plain text matches as a substring; "/pattern/flags" is a regex. */
    words: [],
    /**
     * Word rules that block the PERSON. Saying one of these once hides every
     * message they have on screen and everything they say afterwards — the
     * blocklist entry is what does the work, so it survives a reload.
     */
    banWords: [],
    /** Blocked authors: { name, at (epoch ms), auto (true if rule-triggered) }. */
    authors: [],
    /**
     * Blocked channels: { name, at (epoch ms), why }. Their videos vanish from
     * home, search, the watch sidebar and Shorts shelves.
     *
     * Ships with a list rather than empty — see src/channels.js. Being the
     * DEFAULT is the whole of it: the first write replaces it with the user's
     * own list, and anyone who already has a blocklist never sees it, because
     * a default is only consulted when there is nothing stored.
     */
    channels: shippedChannels(),

    /** "hide" removes the row; "collapse" leaves a one-line stub saying why. */
    hideMode: "hide",
    /** Plain-text rules only match on word boundaries. Regex rules are unaffected. */
    wholeWord: false,
    /** Plain-text rules become case-sensitive. Regex rules keep their own flags. */
    caseSensitive: false,
    /** Also test word rules against the author's name, not just the message. */
    matchAuthorNames: false,
    /** Never hide the channel owner or a moderator, whatever the rules say. */
    protectStaff: true,

    /** Auto-block an author after this many messages caught by word rules. 0 = off. */
    repeatLimit: 3,

    /** Threaded reading view. */
    threads: true,
    /** A thread jumps to the bottom when it gets a new reply. */
    bumpThreads: true,

    /** Show the SHUT UP button on every message row. */
    showButton: true,

    /**
     * Shorts on the subscriptions feed. Off hides the shelf; the switch beside
     * it stays, which is why the switch is not inside the shelf.
     */
    subsShorts: true,

    /**
     * Tabs across the top of the subscriptions feed. Editable — this is only
     * the set it starts with, and the order here is the order they appear in.
     */
    subTabs: [
      "Watch",
      "News",
      "Politics",
      "Podcasts",
      "Science",
      "Tech",
      "Comedy",
      "Music",
      "Favourites",
    ],
    /**
     * Which tabs a channel appears under: { normalised channel name: [tab] }.
     *
     * Keyed by CHANNEL, not by video. A feed replaces itself every few hours,
     * so tagging videos one at a time would never be finished; tagging the
     * channel once routes everything it posts from then on.
     */
    subTags: {},
    /**
     * Single videos put in a tab: { watch link: [tab] }. What "Watch" is for —
     * one video you mean to come back to, rather than a whole channel.
     *
     * These tabs filter what the feed is showing, they do not fetch anything,
     * so a video kept here is reachable for as long as YouTube still puts it
     * in the feed and no longer. It is a pile for today, not a list.
     */
    subVideoTags: {},
    /**
     * The view currently showing.
     *
     * "" is Unsorted: videos in no tab at all, which is the pile left to sort.
     * "*" is All: everything, filtered by nothing. Anything else is that tab.
     */
    subTab: "",
    /** How many times the shipped tab list has been merged in. See load(). */
    subTabsVersion: 0,
    /**
     * Shipped tabs the user has deleted, lowercased.
     *
     * The merge below re-applies the whole shipped list, so without a record
     * of what was thrown away it comes back: delete Science, and the next
     * release that adds any tab resurrects it. Remembering the deletions is
     * what makes "remove" mean removed.
     */
    subTabsRemoved: [],

    stats: { hidden: 0, blocked: 0 },
  };

  /** Bumped when DEFAULTS.subTabs changes in a way that should reach everyone. */
  const DEFAULTS_TABS_VERSION = 3;

  function clone(value) {
    return typeof structuredClone === "function"
      ? structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  }

  /**
   * Fill in anything a stored config predates. Extensions get updated with
   * settings already on disk, so a new key must never read as undefined.
   */
  function withDefaults(stored) {
    const out = clone(DEFAULTS);
    if (!stored || typeof stored !== "object") return out;
    for (const [k, v] of Object.entries(stored)) {
      if (!(k in out)) continue;
      if (v === null || v === undefined) continue;
      out[k] = Array.isArray(out[k]) && !Array.isArray(v) ? out[k] : v;
    }
    out.stats = Object.assign(clone(DEFAULTS.stats), stored.stats || {});

    // A tab added to the shipped list has to reach configs that already have a
    // list of their own, or it never appears for anyone who used the feature
    // before it was added — the stored list shadows the default entirely.
    //
    // Once, counted, and not on every load: run every time, this would put
    // back a default tab somebody deliberately deleted, over and over.
    if ((stored.subTabsVersion || 0) < DEFAULTS_TABS_VERSION) {
      // The shipped ones in the shipped order, so a reshuffle of the defaults
      // (Favourites to the end, say) reaches a list that already exists, then
      // anything added by hand, kept in the order it was added.
      const shipped = new Set(DEFAULTS.subTabs.map((t) => t.toLowerCase()));
      const binned = new Set(
        (out.subTabsRemoved || []).map((t) => String(t).toLowerCase()),
      );
      out.subTabs = [
        ...DEFAULTS.subTabs.filter((name) => !binned.has(name.toLowerCase())),
        ...out.subTabs.filter((t) => !shipped.has(String(t).toLowerCase())),
      ];
      out.subTabsVersion = DEFAULTS_TABS_VERSION;
    }

    // Drop channel entries that were never channels. Extraction used to take
    // the first metadata row under a title, which on a channel's own pages is
    // the view count — so lists filled up with "48K views", one per video,
    // none of them blocking anything. Cleaned on load so an existing list
    // tidies itself rather than needing the user to prune it by hand.
    const filters = globalThis.YTCT && globalThis.YTCT.filters;
    if (filters && Array.isArray(out.channels)) {
      out.channels = out.channels.filter((c) =>
        filters.looksLikeChannel(c && c.name != null ? c.name : c)
      );
    }
    return out;
  }

  async function load() {
    const got = await api.storage.local.get(KEY);
    const stored = got && got[KEY];
    const config = withDefaults(stored);
    // The merge above has to be written down to count as done. Left unsaved it
    // would happen on every load, which is the same as never having counted.
    if (stored && config.subTabsVersion !== (stored.subTabsVersion || 0)) {
      await save(config);
    }
    return config;
  }

  async function save(config) {
    await api.storage.local.set({ [KEY]: config });
    return config;
  }

  /**
   * Read-modify-write. The mutator may return a new config or edit in place.
   * Kept here so callers never race each other through a get/set pair of their
   * own — the content script writes from event handlers while the options page
   * may be open on the same data.
   */
  async function update(mutate) {
    const current = await load();
    const next = (await mutate(current)) || current;
    return save(next);
  }

  /** Fires whenever anything writes the config, including another tab. */
  function onChange(callback) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[KEY]) return;
      callback(withDefaults(changes[KEY].newValue));
    });
  }

  YTCT.store = { DEFAULTS, load, save, update, onChange, withDefaults, clone };
})(globalThis.YTCT);
