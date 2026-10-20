"use strict";
/**
 * Runs inside Google My Activity (myactivity.google.com/page?page=youtube_…),
 * injected by comments.js. That page is the only place that lists every
 * comment, reply and chat message an account has left, and each entry on it
 * has its own delete button — so this walks the list, asks the filters about
 * each entry, and presses that button for the ones they pick.
 *
 * Read from the page as it renders with hl=en (comments.js opens it so):
 *   c-wiz[data-token]              one entry; data-token is the comment id
 *     data-date                    YYYYMMDD
 *     button[aria-label^=PREFIX]   its delete button; the label carries the full text
 *     .SiEggd                      "Commented on <a>title</a>" and the like
 * The list loads more as it is scrolled to the bottom.
 */
(function () {
  if (globalThis.__ytmActivity) return;
  globalThis.__ytmActivity = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const PREFIX = "Delete activity item";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function read(entry) {
    const button = entry.querySelector(`button[aria-label^="${PREFIX}"]`);
    if (!button) return null;
    const label = button.getAttribute("aria-label").slice(PREFIX.length).trim();
    const line = entry.querySelector(".SiEggd");
    const link = line && line.querySelector("a[href]");
    const title = link ? link.textContent.trim() : "";
    const kind = line ? line.textContent.replace(title, "").trim() : "";
    return {
      token: entry.getAttribute("data-token"),
      date: entry.getAttribute("data-date") || "",
      text: label || (entry.querySelector(".QTGV3c")?.textContent || "").trim(),
      kind,
      title,
      url: link ? link.href : "",
      button,
    };
  }

  /** One rule: "/pattern/flags" is a regex, anything else a case-blind substring. */
  function rule(line) {
    const m = /^\/(.+)\/([a-z]*)$/.exec(line);
    if (m) {
      try {
        const re = new RegExp(m[1], m[2]);
        return (s) => re.test(s);
      } catch {
        return () => false;
      }
    }
    const needle = line.toLowerCase();
    return (s) => s.toLowerCase().includes(needle);
  }

  function rules(lines) {
    const list = (lines || []).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(rule);
    return list.length ? (s) => list.some((r) => r(s)) : null;
  }

  function matcher(f) {
    const text = rules(f.text);
    const title = rules(f.titles);
    const from = (f.from || "").replace(/-/g, "");
    const to = (f.to || "").replace(/-/g, "");
    const picked = (item) => {
      if (from && item.date && item.date < from) return false;
      if (to && item.date && item.date > to) return false;
      if (f.kind === "comments" && /^replied/i.test(item.kind)) return false;
      if (f.kind === "replies" && !/^replied/i.test(item.kind)) return false;
      if (text && !text(item.text)) return false;
      if (title && !title(item.title)) return false;
      return true;
    };
    // "except": the filters name what to keep, and everything else goes.
    return f.mode === "except" ? (item) => !picked(item) : picked;
  }

  /** Press delete, answer a confirmation if one appears, wait for the entry to go. */
  async function remove(entry, button) {
    button.click();
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
        .find((d) => d.offsetParent !== null || d.getClientRects().length);
      if (dialog) {
        const ok = [...dialog.querySelectorAll("button")].find((b) => /^\s*delete\s*$/i.test(b.textContent));
        if (ok) ok.click();
      }
      if (!entry.isConnected || !entry.querySelector(`button[aria-label^="${PREFIX}"]`) ||
          entry.getClientRects().length === 0) {
        return true;
      }
    }
    return false;
  }

  async function more(seenCount) {
    // Several nudges: the list only fetches when its sentinel scrolls into view.
    for (let i = 0; i < 6; i++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(1500);
      if (document.querySelectorAll("c-wiz[data-token]").length !== seenCount) return true;
    }
    return false;
  }

  api.runtime.onConnect.addListener((port) => {
    if (port.name !== "ytm-activity") return;
    let gone = false;
    let stopped = false;
    port.onDisconnect.addListener(() => (gone = stopped = true));
    const send = (msg) => {
      if (!gone) port.postMessage(msg);
    };
    send({ type: "ready", listed: document.querySelectorAll("c-wiz[data-token]").length });

    port.onMessage.addListener(async (msg) => {
      if (msg.op === "stop") {
        stopped = true;
        return;
      }
      if (msg.op !== "run") return;
      const wanted = matcher(msg.filters || {});
      const seen = new Set();
      let checked = 0;
      let matched = 0;
      let deleted = 0;
      let failed = 0;
      while (!stopped) {
        const fresh = [...document.querySelectorAll("c-wiz[data-token]")]
          .filter((e) => !seen.has(e.getAttribute("data-token")));
        if (!fresh.length) {
          if (!(await more(document.querySelectorAll("c-wiz[data-token]").length))) break;
          continue;
        }
        for (const entry of fresh) {
          if (stopped) break;
          seen.add(entry.getAttribute("data-token"));
          const item = read(entry);
          if (!item) continue;
          checked++;
          if (!wanted(item)) continue;
          matched++;
          const { button, ...plain } = item;
          let outcome = "found";
          if (msg.delete) {
            entry.scrollIntoView({ block: "center" });
            if (await remove(entry, button)) {
              deleted++;
              outcome = "deleted";
            } else {
              failed++;
              outcome = "failed";
            }
            await sleep(msg.delay || 1500);
          }
          send({ type: "item", item: plain, outcome, checked, matched, deleted, failed });
        }
        send({ type: "count", checked, matched, deleted, failed });
      }
      send({ type: "done", checked, matched, deleted, failed, stopped });
    });
  });
})();
