"use strict";
/**
 * Threading model.
 *
 * YouTube live chat has no reply feature — people improvise one by typing
 * "@Someone ..." — so a thread has to be inferred from mentions. The model is
 * deliberately two levels deep (root + replies) rather than a general tree:
 * chat conversations are short exchanges, and nesting five deep in a 300px
 * column is less readable than the flat list we are trying to improve on.
 */
globalThis.YTCT = globalThis.YTCT || {};
(function (YTCT) {
  const normalizeName = YTCT.filters
    ? YTCT.filters.normalizeName
    : (v) => String(v ?? "").trim().toLowerCase();

  class ThreadStore {
    constructor(options) {
      const opts = options || {};
      /** How far back a mention may reach for its parent. */
      this.windowMs = opts.windowMs ?? 10 * 60 * 1000;
      /** Messages kept for parent lookup. */
      this.maxRecent = opts.maxRecent ?? 400;
      /** Threads kept rendered. */
      this.maxThreads = opts.maxThreads ?? 150;

      this.recent = [];
      this.byId = new Map();
      /** rootId -> { root, replies: [] }, in insertion order. */
      this.threads = new Map();
    }

    /**
     * File a message. Idempotent by id, because a rescan (config change) walks
     * messages that are already on screen and already threaded.
     *
     * @returns {{rootId: string, isReply: boolean, parent: object|null, known: boolean}}
     */
    add(message) {
      const existing = this.byId.get(message.id);
      if (existing) {
        return {
          rootId: existing.rootId,
          isReply: existing.rootId !== existing.id,
          parent: existing.parent || null,
          known: true,
        };
      }

      const parent = this.findParent(message);
      const rootId = parent ? parent.rootId || parent.id : message.id;
      const entry = Object.assign({}, message, { rootId, parent: parent || null });

      this.byId.set(entry.id, entry);
      this.recent.push(entry);
      if (this.recent.length > this.maxRecent) {
        const dropped = this.recent.shift();
        // Keep byId for anything still owning a thread, so a late reply can
        // still find its root; only forget genuinely orphaned messages.
        if (!this.threads.has(dropped.id)) this.byId.delete(dropped.id);
      }

      if (parent) {
        const thread = this.threads.get(rootId);
        if (thread) thread.replies.push(entry);
        else this.threads.set(rootId, { root: parent, replies: [entry] });
      } else {
        this.threads.set(rootId, { root: entry, replies: [] });
      }

      return { rootId, isReply: !!parent, parent: parent || null, known: false };
    }

    /**
     * Resolve "@Name ..." to the message being answered.
     *
     * Names contain spaces, so the mention cannot be tokenized on whitespace —
     * "@Bob Smith what" would look like a mention of "Bob". Instead every recent
     * author name is tested as a prefix of the text after the "@", and the
     * LONGEST match wins, which picks "Bob Smith" over "Bob" when both are in
     * the room. Ties go to the most recent speaker.
     */
    findParent(message) {
      const text = String(message.text || "");
      const at = text.indexOf("@");
      if (at < 0) return null;

      const after = normalizeName(text.slice(at + 1));
      if (!after) return null;

      const cutoff = (message.ts || Date.now()) - this.windowMs;
      let best = null;
      let bestLength = 0;

      for (let i = this.recent.length - 1; i >= 0; i--) {
        const candidate = this.recent[i];
        if ((candidate.ts || 0) < cutoff) break;
        if (candidate.id === message.id) continue;
        // Someone @-ing themselves is a correction, not a reply.
        if (normalizeName(candidate.author) === normalizeName(message.author)) continue;

        const name = normalizeName(candidate.author);
        if (!name || name.length <= bestLength) continue;
        if (after.startsWith(name)) {
          best = candidate;
          bestLength = name.length;
        }
      }
      return best;
    }

    /** Drop the oldest threads, returning their ids so the view can unmount them. */
    trim() {
      const dropped = [];
      while (this.threads.size > this.maxThreads) {
        const oldest = this.threads.keys().next().value;
        if (oldest === undefined) break;
        this.threads.delete(oldest);
        dropped.push(oldest);
      }
      return dropped;
    }

    clear() {
      this.recent.length = 0;
      this.byId.clear();
      this.threads.clear();
    }
  }

  YTCT.threads = { ThreadStore };
})(globalThis.YTCT);
