"use strict";
/**
 * Rule compilation and the hide/keep decision.
 *
 * Pure functions with no DOM and no storage — that is what makes the whole
 * filtering side testable without a browser (see test/logic_test.ts).
 */
globalThis.YTCT = globalThis.YTCT || {};
(function (YTCT) {
  /**
   * Fold a display name to something that survives the usual evasions.
   *
   * Chat spammers pad names with zero-width characters and use full-width or
   * styled unicode letters, so a blocklist that compares raw strings misses the
   * same person on their next message. NFKC folds the styled variants back to
   * plain letters; the explicit strip handles the invisibles NFKC keeps.
   */
  function normalizeName(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  const REGEX_RULE = /^\/(.+)\/([gimsuy]*)$/;
  const ESCAPE = /[.*+?^${}()|[\]\\]/g;

  /**
   * Compile word rules once per config change rather than per message: chat can
   * arrive faster than one message per frame, and building a RegExp per rule per
   * message was the obvious way to make the page stutter.
   *
   * A rule written as /pattern/flags keeps exactly the flags it was written
   * with. The global caseSensitive/wholeWord settings deliberately do not touch
   * it — someone writing a regex has already said what they mean.
   */
  function compile(words, options) {
    const caseSensitive = !!(options && options.caseSensitive);
    const wholeWord = !!(options && options.wholeWord);
    const compiled = [];

    for (const raw of words || []) {
      const src = String(raw ?? "").trim();
      if (!src || src.startsWith("#")) continue;

      const asRegex = REGEX_RULE.exec(src);
      try {
        if (asRegex) {
          compiled.push({ src, re: new RegExp(asRegex[1], asRegex[2]) });
        } else {
          const escaped = src.replace(ESCAPE, "\\$&");
          // \p{L}/\p{N} rather than \b: chat is full of emoji, CJK and
          // punctuation, and \b treats every one of those as a word boundary.
          const body = wholeWord
            ? `(?:^|[^\\p{L}\\p{N}])${escaped}(?:[^\\p{L}\\p{N}]|$)`
            : escaped;
          compiled.push({ src, re: new RegExp(body, caseSensitive ? "u" : "iu") });
        }
      } catch (error) {
        // A broken regex must not take the rest of the list down with it. The
        // options page surfaces .error so the typo is visible.
        compiled.push({ src, error: String((error && error.message) || error) });
      }
    }
    return compiled;
  }

  /** Blocked-author lookup set, normalized once per config change. */
  function blockSet(authors) {
    const set = new Set();
    for (const entry of authors || []) {
      const name = normalizeName(entry && entry.name != null ? entry.name : entry);
      if (name) set.add(name);
    }
    return set;
  }

  /**
   * Decide a single message.
   *
   * "banword" is the loud one: it means this message has earned its author a
   * place on the blocklist. The caller acts on that, because blocking is a
   * write and this function stays pure.
   *
   * @returns {{hide: boolean, reason?: "author"|"banword"|"word"|"protected", rule?: string}}
   */
  function decide(message, context) {
    const config = (context && context.config) || {};
    if (config.enabled === false) return { hide: false };

    // Staff protection runs before everything: an owner or moderator saying a
    // word you filtered is nearly always the answer to it, not more of it.
    if (
      config.protectStaff !== false &&
      (message.authorType === "owner" || message.authorType === "moderator")
    ) {
      return { hide: false, reason: "protected" };
    }

    const blocked = (context && context.blocked) || new Set();
    if (blocked.has(normalizeName(message.author))) {
      return { hide: true, reason: "author", rule: message.author };
    }

    const haystacks = config.matchAuthorNames
      ? [message.text || "", message.author || ""]
      : [message.text || ""];

    // Ban rules are tested before hide rules: a phrase that costs someone their
    // whole account here should not be downgraded to a single hidden message
    // just because it also matched a milder rule first.
    for (const rule of (context && context.banRules) || []) {
      if (!rule.re) continue;
      for (const hay of haystacks) {
        rule.re.lastIndex = 0;
        if (rule.re.test(hay)) return { hide: true, reason: "banword", rule: rule.src };
      }
    }

    for (const rule of (context && context.rules) || []) {
      if (!rule.re) continue;
      for (const hay of haystacks) {
        // Global regexes carry lastIndex between calls, which would make a rule
        // match every other message.
        rule.re.lastIndex = 0;
        if (rule.re.test(hay)) return { hide: true, reason: "word", rule: rule.src };
      }
    }

    return { hide: false };
  }

  /**
   * First rule that matches the text, or null. Used for video titles, where
   * there is no author and no staff to protect — decide() stays chat-shaped.
   */
  function firstMatch(rules, text) {
    for (const rule of rules || []) {
      if (!rule.re) continue;
      // Global regexes carry lastIndex between calls.
      rule.re.lastIndex = 0;
      if (rule.re.test(text)) return rule;
    }
    return null;
  }

  YTCT.filters = { normalizeName, compile, blockSet, decide, firstMatch };
})(globalThis.YTCT);
