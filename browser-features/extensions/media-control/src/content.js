"use strict";
/**
 * Runs on every page.
 *
 * Two jobs: take out anything that links to a blocked outlet, and offer a
 * button to add one. Hiding is by class and never by removing nodes — sites
 * recycle their own elements and removing them breaks their rendering.
 */
(function () {
  const api = globalThis.browser ?? globalThis.chrome;
  const { store, match, outlets } = globalThis.FKOF;

  if (location.protocol !== "http:" && location.protocol !== "https:") return;

  /**
   * Containers that are known to be one item in a list. Used for two things:
   * hiding the whole result rather than just its headline, and deciding where
   * a hover button may appear. Anything not listed still gets hidden — the
   * climb below works it out — it just gets no button.
   */
  const CARD_SELECTORS = [
    // Search
    "div.g", // Google, classic result
    "div[data-hveid] > div[data-ved]", // Google, newer wrappers
    "div.MjjYud", // Google, result block
    "article[data-testid='result']", // DuckDuckGo
    "li.b_algo", // Bing
    "div.result", // Startpage, Searx and friends
    // News aggregators
    "article", // Google News, most news front pages
    "main c-wiz div[jscontroller]", // Google News cluster cards
    // Social
    "shreddit-post", // Reddit
    "div.thing", // old.reddit
    "article[data-testid='tweet']", // X
    "div[data-testid='cellInnerDiv']", // X timeline cell
    "div[role='article']", // Facebook, Mastodon, Bluesky
    "li.athing", // Hacker News
    // Entity panels: the box a search engine shows ABOUT an outlet — logo,
    // blurb, "official website" link. Named directly because the general rule
    // cannot find them: they also link the outlet's Wikipedia entry and its
    // YouTube channel, which anywhere else would mean "this box holds other
    // sites' results, stop".
    "ol.react-results--sidebar", // DuckDuckGo sidebar
    "div.kp-wholepage", // Google knowledge panel
    "#rhs", // Google right-hand column
  ];
  const CARD_QUERY = CARD_SELECTORS.join(",");

  /** How far up from a link we are willing to hide. */
  const MAX_CLIMB = 6;
  const CLIMB_STOP = new Set([
    "BODY", "HTML", "MAIN", "NAV", "HEADER", "FOOTER", "ASIDE", "SECTION", "FORM",
  ]);

  let config = null;
  let index = new Map();
  let generation = 0;

  /**
   * Aggregators that link every article through their own redirect, so the
   * publisher's domain never appears in the markup and only the printed name
   * says who wrote it.
   */
  const LABEL_SITES = ["news.google.com"];
  const onLabelSite = LABEL_SITES.includes(
    match.normalizeHost(location.hostname),
  );

  /** Printed publisher name -> outlet. Only built where it is needed. */
  let labelIndex = new Map();

  function buildLabelIndex() {
    const map = new Map();
    if (!onLabelSite) return map;
    const allowed = new Set(config.allowed || []);
    for (const outlet of outlets) {
      if (allowed.has(outlet.key)) continue;
      for (const label of [outlet.name, ...(outlet.labels || [])]) {
        const key = String(label || "").trim().toLowerCase();
        if (key) map.set(key, outlet);
      }
    }
    return map;
  }

  function rebuild() {
    index = match.buildIndex(config, outlets);
    labelIndex = buildLabelIndex();
    generation += 1;
    document.documentElement.classList.toggle(
      "fkof-buttons",
      config.enabled !== false && config.showButton !== false,
    );
  }

  /* ------------------------------------------------------------- the climb */

  /**
   * From a link, find the thing worth hiding.
   *
   * Known containers win outright. Otherwise climb while the box is still
   * about this one link: the moment an ancestor also holds a link to somebody
   * else, we have left the item and entered the list, so the previous
   * ancestor was the item. Six levels is the ceiling — beyond that a wrong
   * guess starts hiding half the page, and hiding nothing is the better
   * failure.
   */
  function cardFor(link, host) {
    const known = link.closest(CARD_QUERY);
    if (known) return known;

    let best = link;
    let node = link.parentElement;
    for (let i = 0; i < MAX_CLIMB && node; i++) {
      if (CLIMB_STOP.has(node.tagName)) break;
      if (holdsOtherLinks(node, host)) break;
      best = node;
      node = node.parentElement;
    }
    // A bare inline link in a sentence: the paragraph is not the item, the
    // link is. Hiding the paragraph would eat somebody else's prose.
    return best === link ? null : best;
  }

  function holdsOtherLinks(node, host) {
    for (const other of node.querySelectorAll("a[href]")) {
      const otherHost = match.hostOf(other.getAttribute("href"), location.href);
      if (!otherHost || otherHost === host) continue;
      if (otherHost === match.normalizeHost(location.hostname)) continue;
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ links */

  function handleLink(link) {
    if (link.dataset.fkofGen === String(generation)) return;
    link.dataset.fkofGen = String(generation);

    const href = link.getAttribute("href");
    const host = match.hostOf(href, location.href);
    if (!host) return;

    const outlet = config.enabled !== false ? match.lookup(host, index) : null;

    if (outlet) {
      link.classList.add("fkof-link");
      link.dataset.fkofOutlet = outlet.name;
      if (config.hideCards !== false) {
        const card = cardFor(link, host);
        if (card) {
          card.classList.add("fkof-hidden");
          card.dataset.fkofWhy = outlet.name;
        }
      }
      return;
    }

    link.classList.remove("fkof-link");

    // Buttons only on recognised result cards, and only for links leaving this
    // site: a button on every link on every page is litter, and the right-click
    // menu already covers everything else.
    if (config.showButton === false || config.enabled === false) return;
    if (host === match.normalizeHost(location.hostname)) return;
    const card = link.closest(CARD_QUERY);
    if (card) ensureButton(card, host);
  }

  function ensureButton(card, host) {
    if (card.querySelector(":scope > .fkof-btn")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fkof-btn";
    btn.textContent = "GTFO";
    btn.title = `Block ${host} everywhere`;
    btn.addEventListener("click", (event) => {
      // Cards are usually one big link; a block must not also be a click-through.
      event.preventDefault();
      event.stopPropagation();
      block(host);
    });
    card.classList.add("fkof-card");
    card.appendChild(btn);
  }

  function block(host) {
    api.runtime.sendMessage({ type: "fkof-block", host }).then(
      () => toast(`Blocked ${host}`, () => unblock(host)),
      () => {},
    );
  }

  function unblock(host) {
    api.runtime.sendMessage({ type: "fkof-unblock", host }).then(
      () => toast(`Unblocked ${host}`),
      () => {},
    );
  }

  /* ------------------------------------------------------------------ toast */

  let toastEl = null;
  let toastTimer = 0;

  function toast(text, undo) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "fkof-toast";
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
        toastEl.classList.remove("fkof-toast-show");
        undo();
      });
      toastEl.appendChild(btn);
    }
    toastEl.classList.add("fkof-toast-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(
      () => toastEl.classList.remove("fkof-toast-show"),
      5000,
    );
  }

  api.runtime.onMessage.addListener((message) => {
    if (message && message.type === "fkof-blocked") {
      toast(`Blocked ${message.host}`, () => unblock(message.host));
    }
  });

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
    for (const link of document.querySelectorAll("a[href]")) handleLink(link);
    if (onLabelSite) scanLabels();
  }

  /**
   * Hide by printed publisher name, for sites where the link cannot say who
   * wrote it.
   *
   * Matching is whole-text equality against a leaf element, never a substring:
   * the publisher label is its own little element reading exactly "Fox News",
   * while a headline mentioning Fox News is a longer string in a different
   * one. That distinction is the only thing keeping this from hiding every
   * article ABOUT an outlet as well as every article BY it.
   */
  function scanLabels() {
    if (labelIndex.size === 0) return;
    for (const el of document.querySelectorAll("div, span")) {
      if (el.childElementCount !== 0) continue;
      if (el.dataset.fkofLabelGen === String(generation)) continue;
      el.dataset.fkofLabelGen = String(generation);

      const outlet = labelIndex.get((el.textContent || "").trim().toLowerCase());
      if (!outlet) continue;

      // No article around it means it is not an article card: on Google News
      // that is the "Topics" chip in the sidebar, which is its own leaf — its
      // parent already holds the next topic along, so there is nothing between
      // the two and the label IS the entry. Hiding the leaf is therefore both
      // correct and the smallest thing that can be hidden.
      const target = cardForLabel(el) || el;
      target.classList.add("fkof-hidden");
      target.dataset.fkofWhy = outlet.name;
    }
  }

  /**
   * From a publisher label to the thing that should disappear with it.
   *
   * Three shapes, measured on the page rather than assumed:
   *
   *   1. an article card — the biggest ancestor still holding exactly ONE
   *      article link. Stopping at the first ancestor with an article link is
   *      too low: that block is the label and headline only, and hiding it
   *      leaves the thumbnail and timestamp behind as an empty panel.
   *   2. a Topics chip — a button whose entire text is the outlet's name.
   *      Hiding the label alone left the button's outline sitting there empty.
   *   3. the source panel — the card with the outlet's logo and a Follow
   *      button, which has no article links at all.
   */
  function cardForLabel(label) {
    const ARTICLE_LINK =
      "a[href^='./read'], a[href^='./articles'], a[href*='/read/']";

    // (1) article card: climb while everything inside is still blocked.
    //
    // "Exactly one article link" is too strict — a story block holds the
    // article plus a related one, and carries the timestamp at ITS level, so
    // stopping below left the timestamp and thumbnail behind as an empty
    // panel. Instead, keep going while every article in the box has a blocked
    // publisher, and stop as soon as somebody else's article is in there too.
    // MAX_CARD_LINKS bounds it: a story block is small, a results list is not.
    const MAX_CARD_LINKS = 3;
    // Deeper than the link-based climb: the story wrapper that carries the
    // timestamp measured SEVEN levels above the publisher label, so a limit of
    // six could never reach it however right the rule was — the block kept its
    // timestamp and thumbnail. What bounds this is MAX_CARD_LINKS and the
    // all-blocked test, not the number.
    const LABEL_CLIMB = 10;
    let node = label.parentElement;
    let card = null;
    for (let i = 0; i < LABEL_CLIMB && node; i++) {
      if (CLIMB_STOP.has(node.tagName)) break;
      // Distinct articles, by href — an article is linked twice, once from
      // its thumbnail and once from its headline, so counting link elements
      // made every single-article block look like two and the all-blocked
      // test failed on its own card.
      const articles = new Set(
        [...node.querySelectorAll(ARTICLE_LINK)].map((a) =>
          a.getAttribute("href"),
        ),
      ).size;
      if (articles > MAX_CARD_LINKS) break;
      if (articles >= 1) {
        if (blockedLabelsIn(node) < articles) break; // somebody else is in here
        card = node;
      }
      node = node.parentElement;
    }
    if (card) return card;

    // (2) chip: an ancestor that says nothing but the outlet's name
    const name = (label.textContent || "").trim();
    node = label.parentElement;
    let chip = null;
    for (let i = 0; i < 3 && node; i++) {
      if (text(node) !== name) break;
      chip = node;
      node = node.parentElement;
    }
    if (chip) return chip;

    // (3) source panel: nearest ancestor carrying its Follow control
    node = label.parentElement;
    for (let i = 0; i < MAX_CLIMB && node; i++) {
      if (CLIMB_STOP.has(node.tagName)) break;
      if (node.querySelectorAll(ARTICLE_LINK).length) break;
      if (/^(follow|share)$/im.test(text(node)) || hasFollow(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /** How many publisher labels inside this box name an outlet we block. */
  function blockedLabelsIn(node) {
    let n = 0;
    for (const el of node.querySelectorAll("div, span")) {
      if (el.childElementCount !== 0) continue;
      // textContent, not innerText: innerText is empty for anything already
      // hidden, so counting with it undercounted every label we had just
      // hidden and the wrapper around them survived.
      if (labelIndex.has((el.textContent || "").trim().toLowerCase())) n += 1;
    }
    return n;
  }

  /** innerText, not textContent: the latter includes <style> rules as text. */
  function text(el) {
    return ((el.innerText != null ? el.innerText : el.textContent) || "").trim();
  }

  function hasFollow(el) {
    for (const b of el.querySelectorAll("button, [role='button']")) {
      if (/^(follow|share)$/i.test(text(b))) return true;
    }
    return false;
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

    // Single-page apps swap results without touching the tree we observed.
    window.addEventListener("popstate", queueScan);
    setInterval(queueScan, 1500);
  });
})();
