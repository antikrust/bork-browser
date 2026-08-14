"use strict";
/**
 * SHUT UP — the content script, running inside YouTube's live_chat iframe.
 *
 * That iframe is the only place these nodes exist; the watch page around it
 * never contains a chat message. Everything hangs off one MutationObserver on
 * the chat's #items list, because appending a custom element to that list is
 * the only signal YouTube gives us that a message arrived.
 *
 * Two deliberate choices worth knowing before editing:
 *
 * 1. Messages are hidden with a CSS class, never removed from the DOM. YouTube
 *    owns that list — it trims it, recycles it and re-renders it when you switch
 *    between "Top chat" and "Live chat" — and deleting its children makes it
 *    fight back. A class it does not know about, it leaves alone.
 *
 * 2. The threaded view is our own DOM in an overlay panel, not a rearrangement
 *    of YouTube's list. Moving a reply up to sit under its parent means moving a
 *    node YouTube is about to trim, while it is managing scroll position.
 *    Rendering our own copy separates "what YouTube thinks is on screen" from
 *    "what the reader sees", and if it ever breaks, closing the panel gives the
 *    normal chat back untouched.
 */
(function () {
  const { store, filters } = globalThis.YTCT;
  const { ThreadStore } = globalThis.YTCT.threads;

  /** Message elements we understand. Anything else (polls, banners) is left alone. */
  const RENDERERS = new Set([
    "YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER",
    "YT-LIVE-CHAT-PAID-MESSAGE-RENDERER",
    "YT-LIVE-CHAT-PAID-STICKER-RENDERER",
    "YT-LIVE-CHAT-MEMBERSHIP-ITEM-RENDERER",
  ]);

  let config = null;
  let rules = [];
  let banRules = [];
  let blocked = new Set();
  /** Bumped on every config change so already-decorated rows get re-judged. */
  let generation = 0;

  /** normalized author -> count of messages caught by word rules this session. */
  const offenders = new Map();
  const threads = new ThreadStore();

  let itemsEl = null;
  let observer = null;
  let bar = null;
  let countEl = null;
  let panel = null;
  let panelList = null;
  /** rootId -> { el, repliesEl } */
  const threadEls = new Map();
  let hiddenThisSession = 0;
  let panelOpen = false;

  /* ------------------------------------------------------------------ config */

  async function refresh(isFirstRun) {
    config = await store.load();
    rules = filters.compile(config.words, config);
    banRules = filters.compile(config.banWords, config);
    blocked = filters.blockSet(config.authors);
    generation++;
    applyRootFlags();
    if (!isFirstRun) rescan();
    updateBar();
  }

  function applyRootFlags() {
    const root = document.documentElement;
    root.classList.toggle("ytct-on", !!config.enabled);
    root.classList.toggle("ytct-buttons", !!config.showButton);
    root.classList.toggle("ytct-panel-open", panelOpen && !!config.threads);
  }

  /* ----------------------------------------------------------------- parsing */

  function textOf(node) {
    return node ? node.textContent.replace(/\s+/g, " ").trim() : "";
  }

  /**
   * Message text including emoji.
   *
   * Custom emoji render as <img alt=":word:">, and rules people actually write
   * ("no :clown: spam") depend on that alt text being part of the string.
   */
  function messageText(node) {
    if (!node) return "";
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) out += child.textContent;
      else if (child.tagName === "IMG") out += child.getAttribute("alt") || "";
      else out += child.textContent || "";
    }
    return out.replace(/\s+/g, " ").trim();
  }

  function parse(node) {
    const author = textOf(node.querySelector("#author-name"));
    const text = messageText(node.querySelector("#message"));
    return {
      // YouTube's own id is stable per message; the fallback only matters for
      // renderers that ship without one, where identity by content is enough.
      id: node.getAttribute("id") || `${author}|${text}`,
      author,
      authorType: node.getAttribute("author-type") || "",
      text,
      ts: Date.now(),
    };
  }

  /* ---------------------------------------------------------------- verdicts */

  function reasonLabel(verdict) {
    if (verdict.reason === "author") return `blocked: ${verdict.rule}`;
    if (verdict.reason === "banword") return `banned for: ${verdict.rule}`;
    if (verdict.reason === "word") return `rule: ${verdict.rule}`;
    return "hidden";
  }

  function handle(node) {
    if (!node || node.nodeType !== 1 || !RENDERERS.has(node.tagName)) return;

    const message = parse(node);
    // Polymer reuses these elements, so "already seen" has to mean this exact
    // message under the current ruleset — not merely "we touched this node".
    if (
      node.dataset.ytctId === message.id &&
      node.dataset.ytctGen === String(generation)
    ) {
      return;
    }
    node.dataset.ytctId = message.id;
    node.dataset.ytctGen = String(generation);

    ensureButton(node, message);

    const verdict = filters.decide(message, { rules, banRules, blocked, config });
    const hide = !!verdict.hide;

    node.classList.toggle("ytct-hidden", hide && config.hideMode === "hide");
    node.classList.toggle("ytct-collapsed", hide && config.hideMode === "collapse");

    if (hide) {
      node.dataset.ytctReason = reasonLabel(verdict);
      hiddenThisSession++;
      // A ban word costs the author everything, not just this message: blocking
      // them re-runs the whole visible list, so what they said before this
      // disappears too, and so does whatever they say next.
      if (verdict.reason === "banword") {
        // Deferred: blocking rescans the whole list, and doing that from inside
        // the walk over one message means re-entering this function mid-verdict.
        queueMicrotask(() => blockAuthor(message.author, `said “${verdict.rule}”`));
      } else if (verdict.reason === "word") {
        noteOffender(message);
      }
    } else {
      delete node.dataset.ytctReason;
      if (config.threads) addToPanel(message);
    }
    updateBar();
  }

  function rescan() {
    hiddenThisSession = 0;
    if (!itemsEl) return;
    for (const child of Array.from(itemsEl.children)) handle(child);
  }

  /* -------------------------------------------------------- repeat offenders */

  function noteOffender(message) {
    if (!config.repeatLimit) return;
    const name = filters.normalizeName(message.author);
    if (!name || blocked.has(name)) return;

    const count = (offenders.get(name) || 0) + 1;
    offenders.set(name, count);
    if (count >= config.repeatLimit) {
      blockAuthor(message.author, `${count} messages caught by rules`);
    }
  }

  /**
   * @param {string} displayName
   * @param {string} [why] Set when a rule did this rather than the reader; it is
   *   shown in the toast and kept on the blocklist entry so the options page can
   *   explain why a name is there weeks later.
   */
  async function blockAuthor(displayName, why) {
    const key = filters.normalizeName(displayName);
    if (!key || blocked.has(key)) return;

    // Optimistic: hide immediately, let the storage write and its change event
    // catch up. Waiting for the round trip leaves the offender on screen for a
    // beat after you have hit the button, which reads as the button not working.
    blocked.add(key);
    generation++;
    rescan();

    await store.update((cfg) => {
      if (cfg.authors.some((a) => filters.normalizeName(a.name) === key)) return cfg;
      cfg.authors.push({ name: displayName, at: Date.now(), auto: !!why, why: why || "" });
      cfg.stats.blocked = (cfg.stats.blocked || 0) + 1;
      return cfg;
    });

    toast(
      why ? `Blocked ${displayName} — ${why}` : `Blocked ${displayName}`,
      "Undo",
      () => unblockAuthor(displayName),
    );
  }

  async function unblockAuthor(displayName) {
    const key = filters.normalizeName(displayName);
    blocked.delete(key);
    offenders.delete(key);
    await store.update((cfg) => {
      cfg.authors = cfg.authors.filter((a) => filters.normalizeName(a.name) !== key);
      return cfg;
    });
  }

  /* --------------------------------------------------------------- SHUT UP  */

  function ensureButton(node, message) {
    if (!config.showButton) return;
    let button = node.querySelector(":scope > .ytct-shutup");
    if (!button) {
      button = document.createElement("button");
      button.className = "ytct-shutup";
      button.type = "button";
      node.appendChild(button);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        blockAuthor(button.dataset.author || "", false);
      });
    }
    button.dataset.author = message.author;
    button.title = `SHUT UP — hide every message from ${message.author}`;
    button.textContent = "SHUT UP";
  }

  /* ------------------------------------------------------------------- chrome */

  function buildChrome() {
    if (bar) return;

    bar = document.createElement("div");
    bar.id = "ytct-bar";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ytct-bar-btn";
    toggle.textContent = "Threads";
    toggle.addEventListener("click", () => setPanel(!panelOpen));

    countEl = document.createElement("span");
    countEl.className = "ytct-count";
    countEl.title = "Messages hidden since this chat opened — click to see the rules";
    countEl.addEventListener("click", openOptions);

    const gear = document.createElement("button");
    gear.type = "button";
    gear.className = "ytct-bar-btn ytct-gear";
    gear.textContent = "⚙";
    gear.title = "SHUT UP settings";
    gear.addEventListener("click", openOptions);

    bar.append(toggle, countEl, gear);
    document.body.appendChild(bar);

    panel = document.createElement("div");
    panel.id = "ytct-panel";
    const head = document.createElement("div");
    head.className = "ytct-panel-head";
    head.textContent = "Threads";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ytct-bar-btn";
    close.textContent = "✕";
    close.addEventListener("click", () => setPanel(false));
    head.appendChild(close);

    panelList = document.createElement("div");
    panelList.id = "ytct-panel-list";

    panel.append(head, panelList);
    document.body.appendChild(panel);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && panelOpen) setPanel(false);
    });
    globalThis.addEventListener("resize", layoutPanel);
  }

  function setPanel(open) {
    panelOpen = open && !!config.threads;
    applyRootFlags();
    if (panelOpen) {
      layoutPanel();
      stickToBottom();
    }
  }

  /**
   * Keep YouTube's message box usable underneath the panel: the point is to read
   * chat differently, not to lose the ability to talk in it.
   */
  function layoutPanel() {
    if (!panel) return;
    const input = document.querySelector("yt-live-chat-message-input-renderer");
    const height = input ? Math.ceil(input.getBoundingClientRect().height) : 0;
    panel.style.bottom = `${height}px`;
  }

  function openOptions() {
    const api = globalThis.browser ?? globalThis.chrome;
    // runtime.openOptionsPage needs a background page in MV3; from a content
    // script the options URL opens perfectly well on its own.
    globalThis.open(api.runtime.getURL("options/options.html"), "_blank");
  }

  function updateBar() {
    if (!countEl) return;
    countEl.textContent = hiddenThisSession === 1 ? "1 hidden" : `${hiddenThisSession} hidden`;
  }

  /* ------------------------------------------------------------------ threads */

  /** Stable per-author colour so the eye can follow one person down the panel. */
  function colorFor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(hash) % 360} 70% 62%)`;
  }

  function messageRow(message, isReply) {
    const row = document.createElement("div");
    row.className = isReply ? "ytct-msg ytct-msg-reply" : "ytct-msg ytct-msg-root";

    const author = document.createElement("span");
    author.className = "ytct-msg-author";
    author.textContent = message.author;
    author.style.color = colorFor(message.author || "");

    const body = document.createElement("span");
    body.className = "ytct-msg-text";
    // textContent, never innerHTML: this is untrusted text from strangers.
    body.textContent = message.text;

    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "ytct-msg-mute";
    mute.textContent = "SHUT UP";
    mute.title = `Hide every message from ${message.author}`;
    mute.addEventListener("click", () => blockAuthor(message.author, false));

    row.append(author, body, mute);
    return row;
  }

  function addToPanel(message) {
    if (!panelList) return;
    const { rootId, isReply, known } = threads.add(message);
    if (known) return;

    const atBottom = isAtBottom();

    if (!isReply) {
      const el = document.createElement("div");
      el.className = "ytct-thread";
      el.appendChild(messageRow(message, false));
      const repliesEl = document.createElement("div");
      repliesEl.className = "ytct-replies";
      el.appendChild(repliesEl);
      panelList.appendChild(el);
      threadEls.set(rootId, { el, repliesEl });
    } else {
      let entry = threadEls.get(rootId);
      if (!entry) {
        // The parent scrolled out of our render window; show the thread rooted
        // on what we still have rather than dropping the reply entirely.
        const thread = threads.threads.get(rootId);
        const el = document.createElement("div");
        el.className = "ytct-thread";
        el.appendChild(messageRow(thread ? thread.root : message, false));
        const repliesEl = document.createElement("div");
        repliesEl.className = "ytct-replies";
        el.appendChild(repliesEl);
        panelList.appendChild(el);
        entry = { el, repliesEl };
        threadEls.set(rootId, entry);
      }
      entry.repliesEl.appendChild(messageRow(message, true));
      if (config.bumpThreads) panelList.appendChild(entry.el);
    }

    for (const dropped of threads.trim()) {
      const entry = threadEls.get(dropped);
      if (entry) entry.el.remove();
      threadEls.delete(dropped);
    }

    if (atBottom) stickToBottom();
  }

  function isAtBottom() {
    if (!panelList) return true;
    return panelList.scrollTop + panelList.clientHeight >= panelList.scrollHeight - 48;
  }

  function stickToBottom() {
    if (panelList) panelList.scrollTop = panelList.scrollHeight;
  }

  /* -------------------------------------------------------------------- toast */

  let toastTimer = 0;
  function toast(text, actionLabel, onAction) {
    let el = document.getElementById("ytct-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "ytct-toast";
      document.body.appendChild(el);
    }
    el.textContent = "";
    const label = document.createElement("span");
    label.textContent = text;
    el.appendChild(label);

    if (actionLabel) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "ytct-bar-btn";
      action.textContent = actionLabel;
      action.addEventListener("click", () => {
        el.remove();
        onAction();
      });
      el.appendChild(action);
    }

    el.classList.add("ytct-toast-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("ytct-toast-show"), 6000);
  }

  /* ----------------------------------------------------------------- plumbing */

  function findItems() {
    return document.querySelector("yt-live-chat-item-list-renderer #items");
  }

  /**
   * (Re)bind to the message list.
   *
   * Switching between "Top chat" and "Live chat" throws the whole list away and
   * builds a new one, so binding once at startup silently stops working the
   * first time the reader touches that menu. Cheap to re-check on a timer.
   */
  function ensureAttached() {
    const found = findItems();
    if (!found || found === itemsEl) return;

    itemsEl = found;
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) handle(node);
      }
    });
    observer.observe(itemsEl, { childList: true });

    buildChrome();
    layoutPanel();
    rescan();
  }

  async function boot() {
    await refresh(true);
    store.onChange(async () => {
      await refresh(false);
    });
    ensureAttached();
    setInterval(ensureAttached, 1000);
    setInterval(layoutPanel, 2000);
  }

  boot().catch((error) => console.error("[SHUT UP] failed to start", error));
})();
