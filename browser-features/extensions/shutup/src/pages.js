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
    "ytd-channel-renderer", // the channel itself, at the top of a search
    "ytd-compact-video-renderer", // watch sidebar (classic)
    "ytd-grid-video-renderer", // older channel grids
    "ytd-reel-item-renderer", // shorts shelf (older)
    "yt-lockup-view-model", // watch sidebar and lists (newer)
    "ytm-shorts-lockup-view-model", // shorts shelf (newer)
    "ytm-shorts-lockup-view-model-v2",
  ];
  const CARDS = CARD_TAGS.join(",");

  /**
   * Shelves that gather several videos under one heading: "Latest from X" and
   * "Latest Shorts from X" sit under the channel in search results, and the
   * plain "Shorts" rows are the same shape. Hiding the videos inside one
   * leaves the heading standing, which still reads as the channel being there.
   */
  const SHELVES = [
    "ytd-shelf-renderer", // "Latest from X" on search
    "ytd-reel-shelf-renderer", // "Latest Shorts from X", and plain Shorts rows
    "grid-shelf-view-model", // the expandable Shorts shelf on search
    "ytd-rich-section-renderer", // the Shorts shelf on the home grid
  ].join(",");

  /**
   * The only reliable mark of a short. A shorts card names no channel
   * anywhere — not in its markup, and not in the data YouTube attaches to the
   * element — so the link is all there is to go on.
   */
  const SHORTS_LINK = "a[href^='/shorts/']";

  let config = null;
  let blockedChannels = new Set();
  let generation = 0;
  let subscribed = new Set();
  let onSubsFeed = false;

  /**
   * No SHUT UP button on channels the user subscribes to. Video cards never
   * admit subscription state, but the guide drawer on the left lists every
   * subscribed channel. On pages where the drawer has not loaded the last
   * good scrape is kept, so the list survives navigating to a watch page.
   */
  function refreshSubscribed() {
    const found = new Set();
    for (const a of document.querySelectorAll(
      "ytd-guide-entry-renderer a[href^='/@'], ytd-guide-entry-renderer a[href^='/channel/']",
    )) {
      const name = (a.getAttribute("title") || a.textContent).trim();
      if (name) found.add(filters.normalizeName(name));
    }
    if (found.size) subscribed = found;
  }

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
    // Newer lockups (watch sidebar, migrated feeds): the channel is a metadata
    // row under the title, plain text with no link. Not reliably the FIRST
    // row — on a channel's own pages the channel is implied and never
    // repeated, so row one there is "48K views". Take the first row that
    // could be a name at all; if none can, fall through to the links below
    // rather than blocking a view count.
    for (const meta of card.querySelectorAll(
      "yt-content-metadata-view-model span, [class*='content-metadata'] span",
    )) {
      const text = meta.textContent.trim();
      if (filters.looksLikeChannel(text)) return text;
    }
    let handle = "";
    for (const a of card.querySelectorAll(
      "a[href^='/@'], a[href^='/channel/']",
    )) {
      const text = a.textContent.trim();
      if (text) return text;
      const m = /^\/(@[^/?]+)/.exec(a.getAttribute("href") || "");
      if (m && !handle) handle = m[1];
    }
    return handle;
  }

  /**
   * On a channel's own pages the cards never name their channel — the page
   * does. The header carries it verbatim; the document title is the fallback
   * because some tabs prefix it ("Videos - Someone - YouTube").
   */
  function pageChannel() {
    if (!/^\/(@|channel\/|c\/|user\/)/.test(location.pathname)) return "";
    const header = document.querySelector(
      "yt-page-header-view-model h1, yt-page-header-renderer h1, #channel-header #text",
    );
    if (header && header.textContent.trim()) return header.textContent.trim();
    return document.title.replace(/ - YouTube$/, "").trim();
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
    ensureButton(card);

    // The generation gate only spares the extraction. Everything below it
    // runs on every pass: YouTube reasserts the class attribute on its
    // elements whenever their data refreshes, silently wiping our classes —
    // a button that shows once and never again is this, healed.
    const key = keyOf(card);
    if (
      card.dataset.ytctGen !== String(generation) ||
      card.dataset.ytctKey !== key
    ) {
      card.dataset.ytctGen = String(generation);
      card.dataset.ytctKey = key;
      card.dataset.ytctChannel = channelOf(card) || pageChannel();
    }

    const channel = card.dataset.ytctChannel || "";
    const norm = channel ? filters.normalizeName(channel) : "";
    // The subscriptions feed is subscribed channels by definition, so no
    // buttons there even when the guide scrape has nothing.
    card.classList.toggle(
      "ytct-has-channel",
      !!channel && !onSubsFeed && !subscribed.has(norm),
    );
    // Shorts are judged on where they sit rather than on a channel, because
    // they never carry one; a blocked channel still loses its normal videos
    // the usual way.
    const stray =
      !!card.querySelector(SHORTS_LINK) && !subscribedShorts(card);
    card.classList.toggle(
      "ytct-video-hidden",
      config.enabled !== false &&
        ((!!norm && blockedChannels.has(norm)) || stray),
    );
  }

  function ensureButton(card) {
    // Re-added every pass for the same reason the classes above are.
    card.classList.add("ytct-card");
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
    card.appendChild(btn);
  }

  /* ----------------------------------------------------------------- shelves */

  /**
   * The shelf's own heading, not one of its videos' — a shelf full of cards
   * has plenty of titles inside it and only the outer one names the channel.
   */
  function shelfTitle(shelf) {
    for (const el of shelf.querySelectorAll("#title, #title-text, h2")) {
      if (el.closest(CARDS)) continue;
      const text = el.textContent.trim();
      if (text) return text;
    }
    return "";
  }

  /**
   * Shorts survive only where something on the page says whose they are and
   * you subscribe to them. Since the cards themselves never say, that leaves
   * three honest answers, and everything outside them is unattributable.
   */
  function subscribedShorts(el) {
    // The subscriptions feed is subscribed channels by definition.
    if (onSubsFeed) return true;
    // A channel's own pages, including its Shorts tab. The Subscribe button is
    // asked first because the guide scrape has nothing to give when the
    // sidebar is collapsed — and collapsed is the default, where
    // ytd-guide-renderer is not in the document at all.
    const page = filters.normalizeName(pageChannel());
    if (page) {
      const sub = document.querySelector(SUBSCRIBE);
      if (sub && saysSubscribed(sub)) return true;
      if (subscribed.has(page)) return true;
    }
    // A shelf gathering one channel's shorts names it in the heading, same as
    // the blocked-channel test below reads it.
    const shelf = el.closest(SHELVES);
    if (shelf) {
      const title = filters.normalizeName(shelfTitle(shelf));
      for (const name of subscribed) {
        if (title.endsWith(name)) return true;
      }
    }
    return false;
  }

  function handleShelf(shelf) {
    const title = filters.normalizeName(shelfTitle(shelf));
    let blocked = false;
    if (title && config.enabled !== false) {
      // The heading ends with the channel's name, whatever words YouTube puts
      // in front of it ("Latest from X", "Latest Shorts from X"), so match the
      // name rather than the phrase. Anchoring it to the end matters: plenty
      // of channels are named as another channel's name plus a suffix, and a
      // plain substring test would hide those too — blocking one channel
      // would silently take out its spin-offs and regional editions.
      for (const name of blockedChannels) {
        if (title.endsWith(name)) {
          blocked = true;
          break;
        }
      }
    }
    // A whole shelf of shorts nobody can attribute to a channel you follow.
    const strayShorts =
      config.enabled !== false &&
      !!shelf.querySelector(SHORTS_LINK) &&
      !subscribedShorts(shelf);
    shelf.classList.toggle("ytct-video-hidden", blocked || strayShorts);
  }

  /* ---------------------------------------------------- channel page button */

  const SUBSCRIBE =
    "ytd-subscribe-button-renderer, yt-subscribe-button-view-model";

  /**
   * Does this Subscribe control say you already subscribe?
   *
   * Its own label, because the `subscribed` attribute the older renderer
   * carried is absent from yt-subscribe-button-view-model — that button reads
   * "Subscribed" and admits it nowhere else.
   */
  function saysSubscribed(anchor) {
    return /^subscribed$/i.test((anchor.textContent || "").trim());
  }

  /**
   * A SHUT UP button beside every Subscribe button on the page — the channel
   * header and the owner bar under a video. Subscribed channels get none, the
   * same rule the cards follow.
   */
  function ensureSubscribeButtons() {
    for (const anchor of document.querySelectorAll(SUBSCRIBE)) {
      // Some layouts nest one inside the other; seat against the inner one, or
      // a single Subscribe grows two buttons.
      if (anchor.querySelector(SUBSCRIBE) || !anchor.parentElement) continue;
      const name = channelForAnchor(anchor);
      if (name) seat(anchor, name);
    }
    // A button whose Subscribe has gone — SPA navigation rebuilt the header —
    // has nothing left to act on.
    for (const button of document.querySelectorAll(".ytct-sub-btn")) {
      const previous = button.previousElementSibling;
      if (!previous || !previous.matches(SUBSCRIBE)) button.remove();
    }
  }

  /** Under a video the owner bar names the channel; elsewhere the page does. */
  function channelForAnchor(anchor) {
    const owner = anchor.closest("ytd-video-owner-renderer, #owner, #upload-info");
    if (owner) {
      const named = owner.querySelector(
        "ytd-channel-name #text, #channel-name #text",
      );
      if (named && named.textContent.trim()) return named.textContent.trim();
    }
    return pageChannel();
  }

  function seat(anchor, name) {
    let button = anchor.nextElementSibling;
    if (!button || !button.classList.contains("ytct-sub-btn")) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "ytct-sub-btn";
      button.addEventListener("click", () => {
        const current = button.dataset.ytctChannel || "";
        if (!current) return;
        if (blockedChannels.has(filters.normalizeName(current))) {
          unblockChannel(current);
        } else {
          blockChannel(current);
        }
      });
      anchor.parentElement.insertBefore(button, anchor.nextSibling);
    }

    // YouTube gives Subscribe its own wrapper on channel pages, and a wrapper
    // built for one child stacks the second underneath. Turning that wrapper
    // into a row cannot disturb anything else, because by this test it holds
    // nothing else. Where Subscribe shares a bar with other buttons (under a
    // video) the bar is already a row and is left alone.
    const wrapper = anchor.parentElement;
    if (wrapper.children.length === 2) wrapper.classList.add("ytct-row");

    button.dataset.ytctChannel = name;
    const key = filters.normalizeName(name);
    const isBlocked = blockedChannels.has(key);
    button.textContent = isBlocked ? "UNBLOCK" : "SHUT UP";
    button.title = isBlocked ? `Show ${name} again` : `Block ${name} everywhere`;
    button.classList.toggle("ytct-on", isBlocked);
    // The Subscribe button itself is the most direct answer to "do they follow
    // this channel"; the guide scrape covers layouts that do not say.
    const subscribedHere = subscribed.has(key) || saysSubscribed(anchor);
    button.style.display =
      config.enabled !== false && !subscribedHere ? "inline-flex" : "none";
  }

  async function blockChannel(name) {
    const key = filters.normalizeName(name);
    if (!key) return;
    // Last line of defence: whatever the extraction believed, never write a
    // view count or a timestamp into the blocklist.
    if (!filters.looksLikeChannel(name)) {
      console.warn("[SHUT UP] refusing to block a non-channel:", name);
      return;
    }
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
    onSubsFeed = location.pathname.startsWith("/feed/subscriptions");
    refreshSubscribed();
    ensureSubscribeButtons();
    for (const card of document.querySelectorAll(CARDS)) {
      // Newer feeds nest a lockup inside a rich item; judge the outer one
      // only, or the same card grows two buttons.
      if (card.parentElement && card.parentElement.closest(CARDS)) continue;
      handle(card);
    }
    for (const shelf of document.querySelectorAll(SHELVES)) handleShelf(shelf);
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
