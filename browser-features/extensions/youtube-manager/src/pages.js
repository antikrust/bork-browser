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
    applyTabClass();
  }

  /**
   * While a tab is selected a cell has to EARN its place: the stylesheet hides
   * every cell not marked as belonging to the tab. The other way round —
   * judging a cell and then hiding it — leaves every cell YouTube has just
   * added on screen until the next pass, which is a faceful of the wrong
   * videos each time the feed pages.
   *
   * Set from scan(), because that is where the page is known: rebuild() runs
   * before the first scan and would have the wrong answer on a fresh load.
   */
  function applyTabClass() {
    document.documentElement.classList.toggle("ytct-tabbed", filtering());
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
      // Collected here rather than every pass. This walks the card's links,
      // and the pass runs once a second over every cell the feed has loaded —
      // which after a while is hundreds of them, and selecting a tab makes
      // YouTube load hundreds more. Nothing about a card's own links changes
      // while it is showing the same video, so reading them once per video is
      // all it is worth.
      card.dataset.ytctHandles = handlesOf(card).join(" ");
      card.dataset.ytctShorts = card.querySelector(SHORTS_LINK) ? "1" : "";
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
    const handles = (card.dataset.ytctHandles || "").split(" ").filter(Boolean);
    const byHandle = handles.some((h) => blockedHandles.has(h));

    const isShorts = card.dataset.ytctShorts === "1";
    const stray = isShorts && !channel && !subscribedShorts(card);
    // Shorts switched off on the subscriptions feed take the loose cards with
    // them, not only the shelf they usually arrive in.
    const shortsOff = onSubsFeed && config.subsShorts === false && isShorts;

    // A view is a filter over what the feed is showing. The mark is what the
    // stylesheet looks for; a cell without it is off screen while filtering,
    // which is also true of cells nothing has judged yet.
    //
    // Unsorted ("") is the one that earns its keep: a video put in a tab
    // leaves it, so what is left is the pile still to sort.
    const view = onSubsFeed ? config.subTab || "" : ALL_VIEW;
    let belongs = true;
    if (onSubsFeed) {
      if (view === ALL_VIEW) belongs = true;
      else if (view === "") belongs = !inAnyTab(norm, key);
      else belongs = inTab(norm, key, view);
    }
    if (filtering() && belongs) card.dataset.ytctTab = view || "unsorted";
    else delete card.dataset.ytctTab;

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

  /**
   * Menu items that are actually on screen.
   *
   * A closed menu leaves its items in the document — measured: four items in
   * the DOM, none of them visible. Searching the document without this found
   * the PREVIOUS menu's Hide on the second press, clicked something nobody
   * could see, hid nothing, and left the new menu standing open.
   */
  function visibleMenuItems() {
    return [...document.querySelectorAll(MENU_ITEM)].filter(
      (entry) => entry.getBoundingClientRect().width > 0,
    );
  }

  /**
   * Press one item in the card's own ⋮ menu, by what it says.
   *
   * Everything that acts on a single video goes through here rather than
   * reimplementing it: YouTube's own menu entry already does the real thing
   * and keeps doing it after this extension is gone.
   */
  async function pressMenuItem(card, matches) {
    const menu = menuButtonOf(card);
    if (!menu) return false;

    // Start from nothing open, so what is found below can only be ours.
    if (visibleMenuItems().length) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await waitFor(() => visibleMenuItems().length === 0);
    }

    menu.click();
    // The menu renders into a popup container at the end of the document, not
    // inside the card, so it is looked for on the whole page.
    const item = await waitFor(() => visibleMenuItems().find(matches) || null);
    if (!item) {
      // Not in this menu. Shut it again rather than pressing whatever else
      // happens to be in there.
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      return false;
    }
    item.click();
    return true;
  }

  const saysHide = (el) =>
    (el.textContent || "").trim().toLowerCase() === HIDE_ITEM;
  /** "Save to Watch later" — matched loosely, because the wording moves about. */
  const saysWatchLater = (el) => /watch later/i.test(el.textContent || "");

  async function hideForNow(card) {
    if (!(await pressMenuItem(card, saysHide))) return;
    card.dataset.ytctDone = "wait";
    // Every press pushes the deadline out, so a run of them clears in one go.
    restartNoticeTimer();
    queueScan();
  }

  /**
   * YouTube's own Save to Watch later, with a note kept here so the Watch tab
   * can find it again in the feed.
   *
   * The saving is YouTube's: it persists, it is in their sidebar, and it is
   * what "watch later" already means. The note is only an index for the tab —
   * no second list of videos to keep.
   */
  async function saveForLater(card, key) {
    if (!(await pressMenuItem(card, saysWatchLater))) {
      toast("No Watch later in this menu");
      return;
    }
    await store.update((c) => {
      const where = (c.subVideoTags = c.subVideoTags || {});
      if (key) where[key] = [...new Set([...(where[key] || []), WATCH_TAB])];
      return c;
    });
    toast("Saved to Watch later");
  }

  /**
   * What YouTube left in the cell. Its own renderers first; otherwise the cell
   * itself once it has stopped linking to a video, which is the one thing the
   * notice and the card it replaced cannot both do.
   */
  function noticeIn(card) {
    if (card.querySelector("a[href*='/watch'], a[href^='/shorts/']")) return null;

    // Inside YouTube's own box, beside its Undo — not appended to the cell,
    // which left DONE floating in the empty space below the box with nothing
    // around it.
    //
    // Found by climbing from the Undo button until the ancestor holds more
    // than the button does, which is the box that also holds the message. The
    // renderer's name has changed before; "the thing with the button and the
    // words in it" has not.
    const button = card.querySelector("button, tp-yt-paper-button");
    if (button) {
      const label = (button.textContent || "").trim().length;
      let box = button.parentElement;
      for (let i = 0; i < 5 && box && box !== card; i++) {
        if ((box.textContent || "").trim().length > label) return box;
        box = box.parentElement;
      }
    }
    const named = card.querySelector(NOTICE);
    return named || card;
  }

  /**
   * Ten seconds, then the cells go on their own. DONE is for not waiting.
   *
   * ONE timer for all of them, restarted by every press. A timer per card made
   * a run of hides vanish one at a time, seconds apart, with the grid closing
   * up under the pointer between each — so they go together now, ten seconds
   * after the last press rather than ten after each.
   */
  const NOTICE_LINGER = 10000;
  let noticeTimer = 0;

  function restartNoticeTimer() {
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      noticeTimer = 0;
      for (const card of document.querySelectorAll("[data-ytct-done='wait']")) {
        clearCell(card);
      }
    }, NOTICE_LINGER);
  }

  function clearCell(card) {
    delete card.dataset.ytctDone;
    card.dataset.ytctHid = "gone";
    card.dataset.ytctHidKey = keyOf(card);
    handle(card);
  }

  function ensureDoneButtons() {
    for (const card of document.querySelectorAll("[data-ytct-done='wait']")) {
      // Undo puts the video back, and then this is an ordinary card again.
      if (card.querySelector("a[href*='/watch'], a[href^='/shorts/']")) {
        delete card.dataset.ytctDone;
        const stale = card.querySelector(".ytct-done");
        if (stale) stale.remove();
        continue;
      }
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
        // The key is recorded as it is now — empty, because the notice links to
        // nothing. If YouTube refills the cell with a video later the key stops
        // matching and the cell comes back, which is what should happen.
        clearCell(card);
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
  let tagBtn = null;
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

    tagBtn = document.createElement("button");
    tagBtn.type = "button";
    tagBtn.id = "ytct-tag-btn";
    tagBtn.textContent = "TAG";
    tagBtn.title = "Put this in one of the feed's tabs";
    tagBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTagMenu(floatBar.dataset.ytctChannel || "", floatBar.dataset.ytctKey || "");
    });

    floatBar.append(blockBtn, hideBtn, tagBtn);
    document.body.appendChild(floatBar);
    return floatBar;
  }

  function hideFloat() {
    hoverCard = null;
    if (floatBar) floatBar.classList.remove("ytct-float-on");
  }

  /*
   * Panels that sit OVER the page: the notifications dropdown, the ⋮ menus,
   * dialogs, the guide drawer.
   *
   * Hit testing below deliberately looks through whatever is painted on top,
   * because the inline preview player covers the thumbnail and the card has to
   * be found underneath it. That is right for the player and wrong for
   * everything else — hovering the notifications panel found whichever card
   * happened to lie behind it and offered to block ITS channel, from a row
   * about somebody liking a comment.
   */
  const OVERLAYS = [
    "ytd-popup-container",
    "tp-yt-iron-dropdown",
    "tp-yt-paper-dialog",
    "ytd-multi-page-menu-renderer",
    "yt-sheet-view-model",
    "tp-yt-app-drawer",
    "#guide",
    "#masthead-container",
  ].join(",");

  /** The card under the pointer, seen through the preview player only. */
  function cardUnder(x, y) {
    // What the pointer is actually ON. If that is a panel, the card behind it
    // is not what is being pointed at.
    const top = document.elementFromPoint(x, y);
    if (top && top.closest && top.closest(OVERLAYS)) return null;

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
      if (tagMenu && (top === tagMenu || tagMenu.contains(top))) return;
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
      card.dataset.ytctShorts !== "1" &&
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
    // Tagging is the subscriptions feed's other job: sorting what is there
    // rather than getting rid of it.
    const canTag = onSubsFeed && (config.subTabs || []).length > 0;
    el.dataset.ytctKey = keyOf(card);
    tagBtn.style.display = canTag ? "inline-flex" : "none";
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
    const tabbed =
      onSubsFeed &&
      !!config.subTab &&
      config.subTab !== ALL_VIEW &&
      !!shelf.querySelector(SHORTS_LINK);
    shelf.classList.toggle(
      "ytct-video-hidden",
      blocked || strayShorts || tabbed,
    );
  }

  /* ----------------------------------------------------- tabs on the feed */

  /*
   * Tabs across the top of the subscriptions feed, each one a filter over what
   * the feed is already showing.
   *
   * Keyed by CHANNEL, with single videos as the exception. A feed replaces
   * itself every few hours, so tagging videos one at a time would never be
   * finished — tag the channel once and everything it posts arrives in that
   * tab from then on. "Watch" is the exception because one video you mean to
   * come back to is not a statement about its channel.
   *
   * Worth knowing what these cannot do: they filter, they do not fetch. A
   * video kept under a tab is reachable for as long as YouTube still puts it
   * in the feed, and no longer.
   */
  /** The one tab that holds single videos rather than whole channels. */
  const WATCH_TAB = "Watch";

  /** The card currently showing a given video, for acting on it after a click. */
  function cardForKey(key) {
    if (!key) return null;
    for (const card of document.querySelectorAll(CARDS)) {
      if (card.parentElement && card.parentElement.closest(CARDS)) continue;
      if (keyOf(card) === key) return card;
    }
    return null;
  }

  function tabsOfChannel(norm) {
    const tags = (config && config.subTags) || {};
    return (norm && tags[norm]) || [];
  }

  function tabsOfVideo(key) {
    const tags = (config && config.subVideoTags) || {};
    return (key && tags[key]) || [];
  }

  function inTab(norm, key, tab) {
    return tabsOfChannel(norm).includes(tab) || tabsOfVideo(key).includes(tab);
  }

  /** In any tab at all — what Unsorted is the absence of. */
  function inAnyTab(norm, key) {
    return tabsOfChannel(norm).length > 0 || tabsOfVideo(key).length > 0;
  }

  /** All: everything, filtered by nothing. Not a tab, and not stored as one. */
  const ALL_VIEW = "*";

  /** Is the feed being filtered at all right now? */
  function filtering() {
    return (
      !!config &&
      config.enabled !== false &&
      onSubsFeed &&
      (config.subTab || "") !== ALL_VIEW
    );
  }

  /**
   * Where the tabs go: in the feed's own heading row, beside "Latest".
   *
   * That row is a flex box about twelve hundred pixels wide holding a heading
   * sixty wide, so the tabs sit in the space already there rather than taking
   * a row of their own. Placed after the heading, not appended, because the
   * row's other children are YouTube's and sit at its end.
   *
   * Falls back to above the grid when the heading is not there — the feed does
   * not always have one, and a tab bar that vanishes with it would be worse.
   */
  function tabsSpot() {
    const row = document.querySelector(
      "ytd-shelf-renderer .grid-subheader #title-container, ytd-shelf-renderer #title-container",
    );
    if (row) {
      const heading = row.querySelector("h2");
      return {
        parent: row,
        before: heading ? heading.nextSibling : row.firstChild,
        inline: true,
      };
    }
    const top = feedTop();
    return top && { ...top, inline: false };
  }

  function ensureTabBar() {
    const wanted =
      onSubsFeed && config.enabled !== false && (config.subTabs || []).length;
    if (!wanted) {
      for (const stale of document.querySelectorAll(".ytct-tabs")) stale.remove();
      return;
    }
    const spot = tabsSpot();
    if (!spot) return;

    let bar = spot.parent.querySelector(":scope > .ytct-tabs");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "ytct-tabs";
      spot.parent.insertBefore(bar, spot.before || null);
    }
    bar.classList.toggle("ytct-inline", !!spot.inline);
    for (const stale of document.querySelectorAll(".ytct-tabs")) {
      if (stale !== bar) stale.remove();
    }

    const names = ["", ALL_VIEW, ...(config.subTabs || [])];
    const current = config.subTab || "";
    // Rebuilt only when the set or the selection changes. The scan runs every
    // second and replacing the buttons under the pointer every time would eat
    // the click that is being made.
    const signature = JSON.stringify([names, current]);
    if (bar.dataset.ytctSig === signature) return;
    bar.dataset.ytctSig = signature;

    bar.textContent = "";
    for (const name of names) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "ytct-tab";
      tab.textContent = name === "" ? "Unsorted" : name === ALL_VIEW ? "All" : name;
      tab.classList.toggle("ytct-on", name === current);
      tab.addEventListener("click", () => {
        const next = (config.subTab || "") === name ? "" : name;
        // Applied here and now, before the write. Going through storage and
        // waiting for the change to come back made pressing a tab feel dead:
        // a write, a round trip and a scan before anything moved on screen.
        config.subTab = next;
        applyTabClass();
        bar.dataset.ytctSig = "";
        scan();
        store.update((c) => {
          c.subTab = next;
          return c;
        });
      });
      bar.appendChild(tab);
    }
  }

  /* --------------------------------------------------------------- tag menu */

  let tagMenu = null;

  function closeTagMenu() {
    if (!tagMenu) return;
    tagMenu.remove();
    tagMenu = null;
  }

  function openTagMenu(name, key) {
    const norm = name ? filters.normalizeName(name) : "";
    if (!norm && !key) return;
    closeTagMenu();

    tagMenu = document.createElement("div");
    tagMenu.id = "ytct-tag-menu";
    const head = document.createElement("p");
    head.className = "ytct-tag-head";
    head.textContent = name || "this video";
    tagMenu.appendChild(head);

    for (const tab of config.subTabs || []) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ytct-tag-row";
      // Whole channel, except Watch — see the comment above inTab.
      const perVideo = tab === WATCH_TAB;
      const on = perVideo
        ? tabsOfVideo(key).includes(tab)
        : tabsOfChannel(norm).includes(tab);
      row.textContent = perVideo ? `${tab} — just this video` : tab;
      row.classList.toggle("ytct-on", on);
      row.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeTagMenu();
        // Putting a single video in Watch means saving it with YouTube's own
        // Save to Watch later. Taking it out again only drops our note: the
        // saving is theirs and theirs is where it is undone.
        if (perVideo && !on) {
          const card = cardForKey(key);
          if (card) await saveForLater(card, key);
          return;
        }
        await store.update((c) => {
          const where = perVideo
            ? (c.subVideoTags = c.subVideoTags || {})
            : (c.subTags = c.subTags || {});
          const id = perVideo ? key : norm;
          if (!id) return c;
          const list = new Set(where[id] || []);
          if (list.has(tab)) list.delete(tab);
          else list.add(tab);
          if (list.size) where[id] = [...list];
          else delete where[id];
          return c;
        });
        toast(on ? `Out of ${tab}` : `In ${tab}`);
      });
      tagMenu.appendChild(row);
    }

    const rect = floatBar.getBoundingClientRect();
    tagMenu.style.left = `${Math.round(rect.left)}px`;
    tagMenu.style.top = `${Math.round(rect.bottom + 6)}px`;
    document.body.appendChild(tagMenu);
    // Next tick, or the click that opened it closes it again.
    setTimeout(() => {
      document.addEventListener("click", closeTagMenu, { once: true });
    }, 0);
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
   * Where the switch lives: the top of the feed, above everything.
   *
   * It used to sit against the shelf, which was fine until the shelf was
   * switched off — then the shelf went and the switch was left stranded
   * halfway down the page beside nothing. Anchored to the feed instead, it is
   * in the same place whichever way it is set.
   */
  function feedTop() {
    const grid = document.querySelector("ytd-rich-grid-renderer");
    if (grid) {
      // Before the grid's own contents, not inside them: the contents box lays
      // its children out as grid cells and would make a cell of this.
      return { parent: grid, before: grid.querySelector("#contents") };
    }
    const shelf = shortsShelves()[0];
    if (shelf && shelf.parentElement) {
      return { parent: shelf.parentElement, before: shelf };
    }
    return null;
  }

  function ensureShortsBar() {
    const wanted =
      onSubsFeed && config.enabled !== false && shortsShelves().length > 0;
    if (!wanted) {
      for (const stale of document.querySelectorAll(".ytct-shorts-bar")) {
        stale.remove();
      }
      return;
    }

    const spot = feedTop();
    if (!spot) return;
    let strip = spot.parent.querySelector(":scope > .ytct-shorts-bar");
    if (!strip) {
      strip = document.createElement("div");
      strip.className = "ytct-shorts-bar";
      const label = document.createElement("span");
      label.textContent = "Shorts";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ytct-shorts-btn";
      button.addEventListener("click", () => {
        store.update((c) => {
          c.subsShorts = c.subsShorts === false;
          return c;
        });
      });
      strip.append(label, button);
      spot.parent.insertBefore(strip, spot.before || null);
    }
    // One switch. Anything left somewhere else is from a previous layout.
    for (const stale of document.querySelectorAll(".ytct-shorts-bar")) {
      if (stale !== strip) stale.remove();
    }

    const on = config.subsShorts !== false;
    const button = strip.querySelector(".ytct-shorts-btn");
    button.textContent = on ? "ON" : "OFF";
    button.title = on ? "Hide Shorts on this feed" : "Show Shorts on this feed";
    button.classList.toggle("ytct-on", on);
    for (const shelf of shortsShelves()) {
      shelf.classList.toggle("ytct-shorts-off", !on);
    }
  }

  /* --------------------------------------------------------- the empty tab */

  /*
   * A tab with no matches is otherwise a blank page. The cells that do not
   * belong are hidden, and YouTube's own loading furniture is hidden with
   * them, so nothing on screen says the tab was understood rather than
   * broken.
   *
   * Held back for EMPTY_GRACE of unbroken emptiness. The feed goes on paging
   * while a thin tab looks for its matches further down, so a message put up
   * the moment a tab is picked would flash on every switch and on every fresh
   * load before the first cells have been judged. The wait is timed from the
   * first empty pass of THIS view, so changing tabs starts it over.
   */
  /*
   * Where the message goes: under the tabs, in the shelf's own block flow,
   * right after the heading row they sit in.
   *
   * The two obvious places are both wrong, measured on the live feed. The
   * grid's #contents is a flex box, so a message put among the cells is laid
   * out as one of them — 208px of a 1741px row. And #contents is also what
   * holds the heading row, so anything placed before it lands ABOVE the tabs,
   * which reads as a stray line at the top of the page rather than an answer
   * about the tab just pressed.
   */
  function emptySpot() {
    const subheader = document.querySelector(
      "ytd-shelf-renderer .grid-subheader",
    );
    if (subheader && subheader.parentElement) {
      return { parent: subheader.parentElement, before: subheader.nextSibling };
    }
    return feedTop();
  }

  const EMPTY_GRACE = 1200;
  let emptyView = null;
  let emptySince = 0;

  function ensureEmptyNotice() {
    // null means nothing is being filtered, so emptiness is not ours to
    // report: All, a disabled add-on, or any page but the feed.
    const view = filtering() ? config.subTab || "" : null;
    // One marked cell that is still painting is enough. Counting them all
    // would walk every cell in a feed that runs to four figures.
    const matched =
      view !== null &&
      !!document.querySelector("[data-ytct-tab]:not(.ytct-video-hidden)");

    if (view !== emptyView) {
      emptyView = view;
      emptySince = 0;
    }
    if (view === null || matched) emptySince = 0;
    else if (!emptySince) emptySince = Date.now();

    if (!emptySince || Date.now() - emptySince < EMPTY_GRACE) {
      for (const stale of document.querySelectorAll(".ytct-empty")) {
        stale.remove();
      }
      return;
    }

    const spot = emptySpot();
    if (!spot) return;
    let note = spot.parent.querySelector(":scope > .ytct-empty");
    if (!note) {
      note = document.createElement("div");
      note.className = "ytct-empty";
      spot.parent.insertBefore(note, spot.before || null);
    }
    // One message. Anything left elsewhere is from a previous layout.
    for (const stale of document.querySelectorAll(".ytct-empty")) {
      if (stale !== note) stale.remove();
    }
    // Unsorted empty is the good ending, not an absence: everything has been
    // filed. The named tabs say "yet", because the feed may still be paging
    // its way down to a match.
    note.textContent =
      view === "" ? "Nothing left to sort" : `Nothing in ${view} yet`;
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
    applyTabClass();
    refreshSubscribed();
    ensureSubscribeButtons();
    ensureTabBar();
    ensureShortsBar();
    ensureDoneButtons();
    for (const card of document.querySelectorAll(CARDS)) {
      // Newer feeds nest a lockup inside a rich item; judge the outer one
      // only, or the same card grows two buttons.
      if (card.parentElement && card.parentElement.closest(CARDS)) continue;
      handle(card);
    }
    for (const shelf of document.querySelectorAll(SHELVES)) handleShelf(shelf);
    // Last, because it reads the marks the loop above has just set.
    ensureEmptyNotice();
  }

  store.load().then((loaded) => {
    config = loaded;
    rebuild();
    scan();

    store.onChange((next) => {
      const tabChanged = (config && config.subTab) !== next.subTab;
      config = next;
      rebuild();
      // A tab being picked is a direct answer to a click, so it happens now.
      // Everything else can wait for the next pass.
      if (tabChanged) scan();
      else queueScan();
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
