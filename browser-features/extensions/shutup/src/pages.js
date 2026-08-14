"use strict";
/**
 * Normal YouTube pages (top frame): channel blocking.
 *
 * The live_chat iframe has its own script (content.js) and this one never runs
 * there — the manifest injects it into top frames only, and the popout chat
 * window (which IS a top frame on /live_chat) is stepped around below.
 *
 * Video cards are hidden with a class, never removed: YouTube owns these nodes
 * and reuses them across navigations, so removal breaks its own rendering.
 */
globalThis.YTCT = globalThis.YTCT || {};
(function (YTCT) {
  if (window.top !== window) return;
  if (location.pathname.startsWith("/live_chat")) return;

  const { store, filters } = YTCT;

  /**
   * Everything YouTube currently renders a video card as, plus the recent
   * past. A page with none of these simply matches nothing.
   */
  const CARD_TAGS = [
    "ytd-rich-item-renderer", // home grid, channel videos
    "ytd-video-renderer", // search results
    "ytd-compact-video-renderer", // watch sidebar (classic)
    "ytd-grid-video-renderer", // older channel grids
    "ytd-reel-item-renderer", // shorts shelf (older)
    "yt-lockup-view-model", // watch sidebar and lists (newer)
    "ytm-shorts-lockup-view-model", // shorts shelf (newer)
    "ytm-shorts-lockup-view-model-v2",
  ];
  const CARDS = CARD_TAGS.join(",");

  let config = null;
  let blockedChannels = new Set();
  let generation = 0;

  function rebuild() {
    blockedChannels = filters.blockSet(config.channels);
    generation += 1;
    document.documentElement.classList.toggle(
      "ytct-cards-on",
      config.enabled !== false && config.showButton !== false,
    );
  }

  /* ------------------------------------------------------------- extraction */

  function channelOf(card) {
    const named = card.querySelector("ytd-channel-name #text");
    if (named && named.textContent.trim()) return named.textContent.trim();
    const link = card.querySelector("a[href^='/@']");
    if (link && link.textContent.trim()) return link.textContent.trim();
    // Newer lockups carry the channel as the first metadata row, no link.
    const meta = card.querySelector("yt-content-metadata-view-model span");
    if (meta && meta.textContent.trim()) return meta.textContent.trim();
    if (link) {
      const handle = /^\/(@[^/?]+)/.exec(link.getAttribute("href") || "");
      if (handle) return handle[1];
    }
    return "";
  }

  /**
   * What the card is showing right now. YouTube refills card elements with new
   * data on SPA navigation; the watch link changing is the reliable sign a
   * card needs judging again.
   */
  function keyOf(card) {
    const a = card.querySelector("a[href*='/watch'], a[href^='/shorts/']");
    return (a && a.getAttribute("href")) || "";
  }

  /* ------------------------------------------------------------------ cards */

  function handle(card) {
    // Outside the generation gate: YouTube may throw the button away when it
    // refills a card, and that alone must not need a rule change to heal.
    ensureButton(card);

    const key = keyOf(card);
    if (
      card.dataset.ytctGen === String(generation) &&
      card.dataset.ytctKey === key
    ) {
      return;
    }
    card.dataset.ytctGen = String(generation);
    card.dataset.ytctKey = key;

    const channel = channelOf(card);
    card.dataset.ytctChannel = channel;
    card.classList.toggle("ytct-has-channel", !!channel);

    const hide =
      config.enabled !== false &&
      !!channel &&
      blockedChannels.has(filters.normalizeName(channel));
    card.classList.toggle("ytct-video-hidden", hide);
  }

  function ensureButton(card) {
    if (card.querySelector(":scope > .ytct-card-btn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ytct-card-btn";
    btn.textContent = "SHUT UP";
    btn.title = "Block this channel everywhere";
    btn.addEventListener("click", (event) => {
      // The whole card is a link; a block must not also be a click-through.
      event.preventDefault();
      event.stopPropagation();
      const name = card.dataset.ytctChannel || "";
      if (name) blockChannel(name);
    });
    card.classList.add("ytct-card");
    card.appendChild(btn);
  }

  async function blockChannel(name) {
    const key = filters.normalizeName(name);
    if (!key) return;
    await store.update((c) => {
      if (!c.channels.some((ch) => filters.normalizeName(ch.name) === key)) {
        c.channels.push({ name, at: Date.now(), why: "shut up button" });
      }
      return c;
    });
    toast(`Blocked ${name}`, () => unblockChannel(name));
  }

  async function unblockChannel(name) {
    const key = filters.normalizeName(name);
    await store.update((c) => {
      c.channels = c.channels.filter(
        (ch) => filters.normalizeName(ch.name) !== key,
      );
      return c;
    });
    toast(`Unblocked ${name}`);
  }

  /* ------------------------------------------------------------------ toast */

  let toastEl = null;
  let toastTimer = 0;

  function toast(text, undo) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "ytct-page-toast";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = "";
    const label = document.createElement("span");
    label.textContent = text;
    toastEl.appendChild(label);
    if (undo) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Undo";
      btn.addEventListener("click", () => {
        hideToast();
        undo();
      });
      toastEl.appendChild(btn);
    }
    toastEl.classList.add("ytct-toast-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 5000);
  }

  function hideToast() {
    if (toastEl) toastEl.classList.remove("ytct-toast-show");
  }

  /* ------------------------------------------------------------------- scan */

  let scanTimer = 0;

  function queueScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = 0;
      scan();
    }, 200);
  }

  function scan() {
    if (!config) return;
    for (const card of document.querySelectorAll(CARDS)) {
      // Newer feeds nest a lockup inside a rich item; judge the outer one
      // only, or the same card grows two buttons.
      if (card.parentElement && card.parentElement.closest(CARDS)) continue;
      handle(card);
    }
  }

  store.load().then((loaded) => {
    config = loaded;
    rebuild();
    scan();

    store.onChange((next) => {
      config = next;
      rebuild();
      queueScan();
    });

    new MutationObserver(queueScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    // YouTube is a single-page app; this fires after every in-app navigation.
    document.addEventListener("yt-navigate-finish", queueScan);

    // Safety net for card content swapped in without a childList mutation.
    setInterval(queueScan, 1000);
  });
})(globalThis.YTCT);
