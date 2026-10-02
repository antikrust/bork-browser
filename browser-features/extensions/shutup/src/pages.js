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
  let blockedHandles = new Set();
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
    blockedHandles = new Set();
    for (const entry of config.channels || []) {
      for (const h of (entry && entry.handles) || []) {
        const squashed = squashHandle(h);
        if (squashed) blockedHandles.add(squashed);
      }
    }
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
   * Every /@handle the card links to.
   *
   * A collaboration names all its channels in one string — "The Daily Beast
   * and Glenn Kirschner", "The Ezra Klein Show and 2 more" — and that string
   * is not any channel's name, so storing it blocked nothing and the video
   * kept coming back. The handles are the same claim without the guesswork:
   * no splitting, no parsing of a sentence, and blocking a collaboration
   * blocks every channel on it.
   */
  function handlesOf(card) {
    const out = [];
    for (const a of card.querySelectorAll("a[href^='/@']")) {
      const m = /^\/@([^/?]+)/.exec(a.getAttribute("href") || "");
      const squashed = m ? squashHandle(m[1]) : "";
      if (squashed && !out.includes(squashed)) out.push(squashed);
    }
    return out;
  }

  /**
   * Does this byline name a blocked channel?
   *
   * Exact match first, which is every ordinary card. Otherwise the byline is
   * checked for a blocked name sitting either side of an " and ", which is how
   * YouTube joins the channels on a collaboration. The name has to be the
   * whole of its side — "Sky News" does not match "Sky News Australia and X" —
   * so a short name cannot swallow a longer one.
   */
  function bylineNames(norm) {
    if (blockedChannels.has(norm)) return true;
    if (!norm.includes(" and ")) return false;
    for (const blocked of blockedChannels) {
      if (!blocked) continue;
      if (
        norm.startsWith(`${blocked} and `) ||
        norm.endsWith(` and ${blocked}`) ||
        norm.includes(` and ${blocked} and `)
      ) {
        return true;
      }
    }
    return false;
  }

  /** Letters and digits only, so @Ezra_Klein and @ezraklein are one thing. */
  function squashHandle(value) {
    return String(value || "")
      .replace(/^@/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
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
      // Never overwrite a good channel with nothing. Starting the inline
      // preview rewrites the card's watch link, which reopens this gate while
      // YouTube is mid-render and the channel name element is briefly absent —
      // writing "" then would drop ytct-has-channel and take the button with
      // it, permanently, because the gate has just closed on the new key.
      const found = channelOf(card) || pageChannel();
      if (found) card.dataset.ytctChannel = found;
    }

    const channel = card.dataset.ytctChannel || "";
    const norm = channel ? filters.normalizeName(channel) : "";
    // A collaboration byline names several channels at once — "The Ezra Klein
    // Show and New York Times Podcast" — and equals none of their names, so a
    // channel blocked on its own never matched its collaborations. Recognise
    // the blocked name inside the byline instead. This reads the byline, it
    // never rewrites it: nothing is split, and what is stored stays exactly as
    // the user blocked it.
    const named = norm && bylineNames(norm);
    // The subscriptions feed is subscribed channels by definition, so no
    // buttons there even when the guide scrape has nothing.
    card.classList.toggle(
      "ytct-has-channel",
      !!channel && !onSubsFeed && !subscribed.has(norm),
    );
    // Shorts get binned only when nothing can say whose they are. On a
    // channel's own pages the page itself names the channel, so they are
    // attributable and get judged on the blocklist like any other video —
    // binning them there emptied the grid, and YouTube answered an empty grid
    // by fetching more forever.
    // Handles are recorded on the card so a click can store them, and are
    // checked here so a channel blocked from a collaboration is recognised on
    // its own videos too.
    const handles = handlesOf(card);
    card.dataset.ytctHandles = handles.join(" ");
    const byHandle = handles.some((h) => blockedHandles.has(h));

    const stray =
      !!card.querySelector(SHORTS_LINK) && !channel && !subscribedShorts(card);
    // Shorts switched off on the subscriptions feed take the loose cards with
    // them, not only the shelf they usually arrive in.
    const shortsOff =
      onSubsFeed &&
      config.subsShorts === false &&
      !!card.querySelector(SHORTS_LINK);

    const hid = hidStateOf(card);
    card.classList.toggle(
      "ytct-video-hidden",
      config.enabled !== false &&
        (named || byHandle || stray || shortsOff || hid === "gone"),
    );
  }

  /* ------------------------------------------------------------ hide for now */

  /*
   * HIDE presses YouTube's own Hide — the one in the card's ⋮ menu — and then
   * puts a DONE button on the card YouTube leaves behind.
   *
   * Pressing YouTube's own is the whole point of it. That Hide already tells
   * the feed not to serve the video again until it is refreshed, and the card
   * it leaves already carries Undo. The only thing missing was a way to get
   * that card off the screen afterwards, and that is all DONE is: nothing is
   * written down here and no second notice is invented.
   */
  /*
   * The ⋮ button, and nothing else on the card.
   *
   * Tried one selector at a time, because a comma-separated querySelector
   * returns whatever comes first in the DOCUMENT rather than the first
   * selector that matches — and on a hovered card the thumbnail's own overlay
   * buttons come first. Written as one list, this pressed Watch Later.
   */
  const MENU_BUTTONS = [
    "ytd-menu-renderer yt-icon-button#button",
    "ytd-menu-renderer button",
    "button[aria-label='More actions']",
    "yt-lockup-metadata-view-model button[aria-label]",
  ];
  /** Three dots in a column — the icon that button has kept through every redesign. */
  const DOTS = /^M12 4a2 2 0/;
  const MENU_ITEM = "[role='menuitem']";
  /** YouTube's own word for it. Nothing else in that menu is ever pressed. */
  const HIDE_ITEM = "hide";
  /** What YouTube puts in the cell instead of the video. */
  const NOTICE =
    "ytd-notification-multi-action-renderer, ytd-dismissal-follow-up-renderer, ytd-feed-nudge-renderer";

  /** Poll until find() returns something, or give up. */
  function waitFor(find, tries = 40, gap = 50) {
    return new Promise((resolve) => {
      let left = tries;
      const tick = () => {
        const found = find();
        if (found || --left <= 0) resolve(found || null);
        else setTimeout(tick, gap);
      };
      tick();
    });
  }

  function menuButtonOf(card) {
    for (const selector of MENU_BUTTONS) {
      const found = card.querySelector(selector);
      if (found) return found;
    }
    // Last resort, and locale-free: the button wearing the three-dot icon.
    // Never "any button" — that is how the overlay buttons got pressed.
    for (const button of card.querySelectorAll("button")) {
      const path = button.querySelector("svg path");
      if (path && DOTS.test(path.getAttribute("d") || "")) return button;
    }
    return null;
  }

  async function hideForNow(card) {
    const menu = menuButtonOf(card);
    if (!menu) return;
    menu.click();
    // The menu renders into a popup container at the end of the document, not
    // inside the card, so it is looked for on the whole page.
    const item = await waitFor(() => {
      for (const entry of document.querySelectorAll(MENU_ITEM)) {
        if ((entry.textContent || "").trim().toLowerCase() === HIDE_ITEM) {
          return entry;
        }
      }
      return null;
    });
    if (!item) {
      // No Hide in this menu. Shut it again rather than pressing whatever else
      // happens to be in there.
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      return;
    }
    item.click();
    card.dataset.ytctDone = "wait";
    queueScan();
  }

  /**
   * What YouTube left in the cell. Its own renderers first; otherwise the cell
   * itself once it has stopped linking to a video, which is the one thing the
   * notice and the card it replaced cannot both do.
   */
  function noticeIn(card) {
    const named = card.querySelector(NOTICE);
    if (named) return named;
    if (card.querySelector("a[href*='/watch'], a[href^='/shorts/']")) return null;
    return card;
  }

  function ensureDoneButtons() {
    for (const card of document.querySelectorAll("[data-ytct-done='wait']")) {
      const notice = noticeIn(card);
      if (!notice || notice.querySelector(":scope > .ytct-done")) continue;
      const done = document.createElement("button");
      done.type = "button";
      done.className = "ytct-done";
      done.textContent = "DONE";
      done.title = "Take this off the page";
      done.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        delete card.dataset.ytctDone;
        card.dataset.ytctHid = "gone";
        // Recorded as it is now — empty, because the notice links to nothing.
        // If YouTube refills the cell with a video later the key stops
        // matching and the cell comes back, which is what should happen.
        card.dataset.ytctHidKey = keyOf(card);
        handle(card);
      });
      notice.appendChild(done);
    }
  }

  /** The hide state — but only while the cell still holds what it was set on. */
  function hidStateOf(card) {
    const state = card.dataset.ytctHid || "";
    if (!state) return "";
    if (card.dataset.ytctHidKey !== keyOf(card)) {
      delete card.dataset.ytctHid;
      delete card.dataset.ytctHidKey;
      return "";
    }
    return state;
  }

  function ensureButton(card) {
    // The class is what the hover tracker below looks for; the button itself
    // is a single floating element, not one per card. See floatButton().
    card.classList.add("ytct-card");
  }

  /* ------------------------------------------------------------ the button */

  /*
   * One button, parked on <body>, moved to whichever card the pointer is over.
   *
   * It cannot live inside the card, and it cannot be driven by :hover, because
   * of what YouTube does when a thumbnail starts previewing (measured, not
   * guessed):
   *
   *   - the preview player is mounted under ytd-app, NOT inside the card, and
   *     positioned over the thumbnail. The pointer is then inside an element
   *     that is not a descendant of the card, so the card stops matching
   *     :hover and any CSS keyed on it hides the button.
   *   - nothing is set on the card to say it is the one previewing — only the
   *     player carries an `active` attribute — so no selector can name it.
   *   - the player sits in its own positioned subtree, so a button inside the
   *     card loses the paint order however large its z-index: the card's
   *     z-index only orders things within the card's own stacking context.
   *
   * A fixed element on <body> is a sibling of that subtree, so it wins, and
   * hit-testing the pointer finds the card underneath the player.
   */
  let floatBar = null;
  let blockBtn = null;
  let hideBtn = null;
  let hoverCard = null;

  function bar() {
    if (floatBar && floatBar.isConnected) return floatBar;
    floatBar = document.createElement("div");
    floatBar.id = "ytct-float-bar";

    blockBtn = document.createElement("button");
    blockBtn.type = "button";
    blockBtn.id = "ytct-float-btn";
    blockBtn.textContent = "SHUT UP";
    blockBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const name = floatBar.dataset.ytctChannel || "";
      const handles = (floatBar.dataset.ytctHandles || "")
        .split(" ")
        .filter(Boolean);
      if (!name) return;
      // Block, never unblock. This used to toggle, and the button is still on
      // screen for a moment after the first press because the card has not
      // been re-judged yet — so a second press on a card that had not vanished
      // yet took the block straight back off, while the label still said
      // SHUT UP. Blocking something repeatedly left it unblocked on every
      // even-numbered press. Undo lives in the toast and in settings.
      blockChannel(name, handles);
    });

    hideBtn = document.createElement("button");
    hideBtn.type = "button";
    hideBtn.id = "ytct-hide-btn";
    hideBtn.textContent = "HIDE";
    hideBtn.title = "Hide this video until the feed is refreshed";
    hideBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const card = hoverCard;
      hideFloat();
      if (card) hideForNow(card);
    });

    floatBar.append(blockBtn, hideBtn);
    document.body.appendChild(floatBar);
    return floatBar;
  }

  function hideFloat() {
    hoverCard = null;
    if (floatBar) floatBar.classList.remove("ytct-float-on");
  }

  /** The card under the pointer, seen through whatever is painted over it. */
  function cardUnder(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      const inner = el.closest && el.closest(CARDS);
      if (!inner) continue;
      // Newer feeds nest a lockup inside a rich item. The outer one is the
      // cell — it is the one scan() judges, the one carrying the channel, and
      // the one that has to go when a video is hidden.
      let card = inner;
      while (card.parentElement && card.parentElement.closest(CARDS)) {
        card = card.parentElement.closest(CARDS);
      }
      return card;
    }
    return null;
  }

  function trackPointer(x, y) {
    if (!config || config.enabled === false || config.showButton === false) {
      hideFloat();
      return;
    }

    // Once the bar is up, the pointer moving ONTO it must not re-aim it.
    // Reaching for a button is itself a mouse move, and the sidebar shifts
    // under the cursor as YouTube re-renders — so re-targeting at that moment
    // blocked whichever channel had slid underneath instead of the one being
    // pointed at. The card you aimed at stayed, and a channel you never chose
    // went on the list.
    if (floatBar && floatBar.classList.contains("ytct-float-on")) {
      const top = document.elementFromPoint(x, y);
      if (top === floatBar || floatBar.contains(top)) return;
    }
    const card = cardUnder(x, y);
    if (!card || card.classList.contains("ytct-video-hidden")) {
      hideFloat();
      return;
    }

    const name = card.dataset.ytctChannel || "";
    const canBlock = !!name && card.classList.contains("ytct-has-channel");
    // HIDE belongs to the subscriptions feed. Everything there is a channel
    // the user follows — which is why no SHUT UP button is offered — so the
    // only thing left to want is this one video out of the way.
    // Only where YouTube offers it: HIDE presses the Hide in the card's own ⋮
    // menu, so a card without that menu has nothing to press.
    const canHide =
      onSubsFeed &&
      !card.querySelector(SHORTS_LINK) &&
      !card.dataset.ytctDone &&
      !hidStateOf(card) &&
      !!keyOf(card) &&
      !!menuButtonOf(card);
    if (!canBlock && !canHide) {
      hideFloat();
      return;
    }

    const el = bar();
    const rect = card.getBoundingClientRect();
    el.dataset.ytctChannel = name;
    el.dataset.ytctHandles = card.dataset.ytctHandles || "";
    blockBtn.style.display = canBlock ? "inline-flex" : "none";
    blockBtn.title = name ? `Block ${name} everywhere` : "";
    hideBtn.style.display = canHide ? "inline-flex" : "none";
    el.style.left = `${Math.round(rect.left + 6)}px`;
    el.style.top = `${Math.round(rect.top + 6)}px`;
    el.classList.add("ytct-float-on");
    hoverCard = card;
  }

  let pointerFrame = 0;
  let lastX = 0;
  let lastY = 0;

  function onPointerMove(event) {
    lastX = event.clientX;
    lastY = event.clientY;
    if (pointerFrame) return;
    // One hit-test per frame at most: mousemove fires far faster than anything
    // here needs to run.
    pointerFrame = requestAnimationFrame(() => {
      pointerFrame = 0;
      trackPointer(lastX, lastY);
    });
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

  /* ------------------------------------------------- shorts on the feed */

  /**
   * Shelves holding shorts, outermost only.
   *
   * Found by what is inside them rather than by renderer name or heading:
   * YouTube has shipped four different elements for this row and renames the
   * heading by locale, but a shelf of shorts always links to /shorts/.
   */
  function shortsShelves() {
    const out = [];
    for (const shelf of document.querySelectorAll(SHELVES)) {
      if (!shelf.querySelector(SHORTS_LINK)) continue;
      if (shelf.parentElement && shelf.parentElement.closest(SHELVES)) continue;
      out.push(shelf);
    }
    return out;
  }

  /**
   * A Shorts on/off switch beside the shelf on the subscriptions feed.
   *
   * It sits BEFORE the shelf rather than inside it, which is the whole point:
   * switching shorts off hides the shelf, and a switch living inside it would
   * go with it and never come back.
   */
  function ensureShortsBar() {
    const wanted = onSubsFeed && config.enabled !== false;
    for (const existing of document.querySelectorAll(".ytct-shorts-bar")) {
      const next = existing.nextElementSibling;
      if (!wanted || !next || !next.matches(SHELVES)) existing.remove();
    }
    if (!wanted) return;

    const on = config.subsShorts !== false;
    for (const shelf of shortsShelves()) {
      let strip = shelf.previousElementSibling;
      if (!strip || !strip.classList.contains("ytct-shorts-bar")) {
        strip = document.createElement("div");
        strip.className = "ytct-shorts-bar";
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ytct-shorts-btn";
        button.addEventListener("click", () => {
          store.update((c) => {
            c.subsShorts = c.subsShorts === false;
            return c;
          });
        });
        strip.append(button);
        shelf.parentElement.insertBefore(strip, shelf);
      }
      const button = strip.querySelector(".ytct-shorts-btn");
      button.textContent = on ? "ON" : "OFF";
      button.title = on
        ? "Hide Shorts on this feed"
        : "Show Shorts on this feed";
      button.classList.toggle("ytct-on", on);
      shelf.classList.toggle("ytct-shorts-off", !on);
    }
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
      // The same extractor the cards use. That one already understands the
      // newer view-model markup and the plain /@ link; this used to know only
      // the old renderer, so a migrated owner bar named nobody and the button
      // was never seated — while sidebar cards, which go through channelOf,
      // kept theirs.
      const found = channelOf(owner);
      if (found) return found;
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

  async function blockChannel(name, handles) {
    const key = filters.normalizeName(name);
    if (!key) return;
    // Last line of defence: whatever the extraction believed, never write a
    // view count or a timestamp into the blocklist.
    if (!filters.looksLikeChannel(name)) {
      console.warn("[SHUT UP] refusing to block a non-channel:", name);
      return;
    }
    const list = Array.isArray(handles) ? handles.filter(Boolean) : [];
    await store.update((c) => {
      const existing = c.channels.find(
        (ch) => filters.normalizeName(ch.name) === key,
      );
      if (existing) {
        // Same name, new handles: a later card may link channels the first one
        // did not, and every one of them belongs on the entry.
        existing.handles = [
          ...new Set([...(existing.handles || []), ...list]),
        ];
      } else {
        c.channels.push({
          name,
          handles: list,
          at: Date.now(),
          why: "shut up button",
        });
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
    ensureShortsBar();
    ensureDoneButtons();
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

    document.addEventListener("mousemove", onPointerMove, { passive: true });
    // The button is placed in viewport coordinates, so anything that moves the
    // page under it has to take it away or it is left pointing at nothing; the
    // next mousemove puts it back.
    document.addEventListener("scroll", hideFloat, {
      passive: true,
      capture: true,
    });
    window.addEventListener("blur", hideFloat);

    // YouTube is a single-page app; this fires after every in-app navigation.
    document.addEventListener("yt-navigate-finish", queueScan);
    document.addEventListener("yt-navigate-start", hideFloat);

    // Safety net for card content swapped in without a childList mutation.
    setInterval(queueScan, 1000);
  });
})(globalThis.YTCT);
