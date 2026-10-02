"use strict";
/**
 * The half that stops a page loading at all.
 *
 * This is why the extension is MV2: blocking webRequest was removed in MV3, so
 * a Chrome extension can only hide links after the fact. Here, typing the URL,
 * clicking a link, or following a redirect all land on the reasons page
 * instead of on their site.
 */
(function () {
  const api = globalThis.browser ?? globalThis.chrome;
  const { store, match, outlets } = globalThis.FKOF;

  let config = store.DEFAULTS;
  let index = new Map();

  /** Domains let through on purpose, host -> expiry timestamp. */
  const passes = new Map();

  function rebuild() {
    index = match.buildIndex(config, outlets);
    buildMenu();
  }

  function hasPass(host) {
    const until = passes.get(host);
    if (!until) return false;
    if (Date.now() > until) {
      passes.delete(host);
      return false;
    }
    return true;
  }

  /* ------------------------------------------------------------- navigation */

  function onBeforeRequest(details) {
    if (!config.enabled || !config.blockNav) return {};
    // The reasons page links back out to the thing it is describing; a block
    // applied to our own page would be a loop.
    if (details.url.startsWith(api.runtime.getURL(""))) return {};

    const host = match.hostOf(details.url);
    if (!host || hasPass(host)) return {};

    const outlet = match.lookup(host, index);
    if (!outlet) return {};

    countBlock();

    const target = new URL(api.runtime.getURL("blocked/blocked.html"));
    target.searchParams.set("u", details.url);
    target.searchParams.set("host", host);
    target.searchParams.set("key", outlet.key);
    return { redirectUrl: target.href };
  }

  api.webRequest.onBeforeRequest.addListener(
    onBeforeRequest,
    { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
    ["blocking"],
  );

  let pending = 0;
  let flushTimer = 0;

  /** Batched: a blocked page can fire several requests, and each write wakes every listener. */
  function countBlock() {
    pending += 1;
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      const n = pending;
      pending = 0;
      flushTimer = 0;
      await store.update((c) => {
        c.stats.blocked += n;
        return c;
      });
    }, 2000);
  }

  /* ----------------------------------------------------------- context menu */

  /**
   * The universal way in. A hover button only exists on surfaces we recognise;
   * right-clicking a link works on every site there will ever be.
   */
  function buildMenu() {
    api.contextMenus.removeAll(() => {
      api.contextMenus.create({
        id: "fkof-block-link",
        title: "Media Control — block this site",
        contexts: ["link"],
      });
      api.contextMenus.create({
        id: "fkof-block-page",
        title: "Media Control — block the site I am on",
        contexts: ["page"],
      });
    });
  }

  api.contextMenus.onClicked.addListener(async (info, tab) => {
    const href =
      info.menuItemId === "fkof-block-link" ? info.linkUrl : info.pageUrl;
    const host = match.hostOf(href);
    if (!host) return;
    await blockHost(host);
    if (tab && tab.id != null) {
      api.tabs.sendMessage(tab.id, { type: "fkof-blocked", host }).catch(() => {
        // No content script on this page (a PDF, a view-source tab); the block
        // still landed, there is just nobody to show a toast.
      });
    }
  });

  async function blockHost(host) {
    const domain = match.normalizeHost(host);
    if (!domain) return;
    await store.update((c) => {
      const already = (c.custom || []).some(
        (e) => match.normalizeHost(e.domain) === domain,
      );
      if (!already) c.custom.push({ domain, name: domain, at: Date.now() });
      // Blocking something the bundle already covers means the user had let it
      // back in; take that permission away again.
      const outlet = match.lookup(domain, match.buildIndex({ allowed: [] }, outlets));
      if (outlet) c.allowed = (c.allowed || []).filter((k) => k !== outlet.key);
      return c;
    });
  }

  /* -------------------------------------------------------------- messages */

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;

    if (message.type === "fkof-block") {
      blockHost(message.host).then(() => sendResponse({ ok: true }));
      return true;
    }

    if (message.type === "fkof-pass") {
      // Fifteen minutes: long enough to read the thing you decided you needed,
      // short enough that it does not quietly become an unblock.
      passes.set(match.normalizeHost(message.host), Date.now() + 15 * 60 * 1000);
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "fkof-unblock") {
      unblockHost(message.host).then(() => sendResponse({ ok: true }));
      return true;
    }

    return false;
  });

  async function unblockHost(host) {
    const domain = match.normalizeHost(host);
    await store.update((c) => {
      c.custom = (c.custom || []).filter(
        (e) => match.normalizeHost(e.domain) !== domain,
      );
      const outlet = match.lookup(domain, match.buildIndex({ allowed: [] }, outlets));
      if (outlet && !(c.allowed || []).includes(outlet.key)) {
        c.allowed = [...(c.allowed || []), outlet.key];
      }
      return c;
    });
    passes.set(domain, Date.now() + 15 * 60 * 1000);
  }

  store.load().then((loaded) => {
    config = loaded;
    rebuild();
    store.onChange((next) => {
      config = next;
      rebuild();
    });
  });
})();
