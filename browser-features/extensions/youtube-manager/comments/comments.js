"use strict";
/**
 * Comment deletion page.
 *
 * Opens Google My Activity in a window of its own, puts activity.js in it, and
 * hands that script the filters. The window has to stay on screen: My
 * Activity loads more of the list only as it is scrolled, and a hidden page
 * barely renders.
 *
 * myactivity.google.com (and "cookies", for opening it in YouTube's
 * container) are optional permissions, asked for the first time Find or
 * Delete is pressed, so nobody is asked for them who never uses this.
 */
(function () {
  const api = globalThis.browser ?? globalThis.chrome;
  const ORIGIN = "https://myactivity.google.com/*";
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let tabId = null;
  let port = null;

  function status(text) {
    $("status").textContent = text;
  }

  function busy(on) {
    $("find").disabled = on;
    $("delete").disabled = on;
    $("stop").hidden = !on;
  }

  function source() {
    return document.querySelector('input[name="source"]:checked').value;
  }

  function filters() {
    const lines = (id) => $(id).value.split("\n");
    return {
      text: lines("text"),
      titles: lines("titles"),
      from: $("from").value,
      to: $("to").value,
      kind: source() === "youtube_comments" ? $("kind").value : "all",
      mode: $("mode").value,
    };
  }

  function pageUrl() {
    return `https://myactivity.google.com/page?hl=en&page=${source()}`;
  }

  /** The My Activity tab: the one opened last time if it's still about, else a new window. */
  async function activityTab() {
    const url = pageUrl();
    if (tabId !== null) {
      try {
        const tab = await api.tabs.get(tabId);
        await api.tabs.update(tab.id, { url, active: true });
        await api.windows.update(tab.windowId, { focused: true });
        return tab.id;
      } catch {
        tabId = null;
      }
    }
    // Google's session lives wherever YouTube's does, which may be a
    // container; a window in the default store would just be signed out.
    const yt = (await api.tabs.query({ url: "https://www.youtube.com/*" }))[0];
    const store = yt && yt.cookieStoreId && yt.cookieStoreId !== "firefox-default"
      ? { cookieStoreId: yt.cookieStoreId }
      : {};
    const win = await api.windows.create({ url, width: 1000, height: 900, ...store });
    tabId = win.tabs[0].id;
    return tabId;
  }

  async function loaded(id) {
    for (let i = 0; i < 120; i++) {
      const tab = await api.tabs.get(id);
      if (tab.status === "complete" && String(tab.url || "").startsWith("https://myactivity.google.com/")) {
        // Signed out, it bounces to a welcome page with the list as ?continue=.
        if (!new URL(tab.url).pathname.startsWith("/page")) {
          throw new Error("Google isn't signed in in the My Activity window — sign in there, then press again");
        }
        return;
      }
      await sleep(500);
    }
    throw new Error("My Activity didn't load — sign in to Google in that window, then press again");
  }

  async function connect(id) {
    for (let attempt = 0; attempt < 20; attempt++) {
      await api.scripting.executeScript({ target: { tabId: id }, files: ["/comments/activity.js"] });
      const p = api.tabs.connect(id, { name: "ytm-activity" });
      const ready = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 1500);
        p.onMessage.addListener(function first(msg) {
          if (msg.type !== "ready") return;
          p.onMessage.removeListener(first);
          clearTimeout(timer);
          resolve(msg);
        });
        p.onDisconnect.addListener(() => {
          clearTimeout(timer);
          resolve(null);
        });
      });
      if (ready) return p;
      try {
        p.disconnect();
      } catch {
        // already gone
      }
      await sleep(500);
    }
    throw new Error("Couldn't start in the My Activity window");
  }

  function logItem(msg) {
    const { item, outcome } = msg;
    const li = document.createElement("li");
    li.className = outcome;
    const what = document.createElement("div");
    what.className = "what";
    what.textContent = item.text;
    const meta = document.createElement("div");
    meta.className = "meta";
    const d = item.date;
    const day = d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : "";
    meta.textContent = [day, item.kind && item.title ? `${item.kind} ${item.title}` : item.title,
      outcome === "failed" ? "NOT deleted" : ""].filter(Boolean).join(" · ");
    li.append(what, meta);
    $("log").append(li);
  }

  function summary(c, verb) {
    const parts = [`Checked ${c.checked}`, `${c.matched} ${verb}`];
    if (c.deleted) parts.push(`${c.deleted} deleted`);
    if (c.failed) parts.push(`${c.failed} could not be deleted`);
    return parts.join(", ");
  }

  async function run(doDelete) {
    if (doDelete && !confirm("Delete everything these filters pick? This cannot be undone.")) return;
    // Has to be asked before anything is awaited, while the click still counts.
    // "cookies" is what lets the window open in a container.
    const granted = await api.permissions.request({ permissions: ["cookies"], origins: [ORIGIN] });
    if (!granted) {
      status("Needs permission for myactivity.google.com to do anything.");
      return;
    }
    busy(true);
    $("log").textContent = "";
    const verb = doDelete ? "picked" : "matched";
    try {
      status("Opening My Activity…");
      const id = await activityTab();
      await loaded(id);
      port = await connect(id);
      status("Working — leave the My Activity window open.");
      await new Promise((resolve, reject) => {
        port.onMessage.addListener((msg) => {
          if (msg.type === "item") {
            logItem(msg);
            status(`${summary(msg, verb)}…`);
          } else if (msg.type === "count") {
            status(`${summary(msg, verb)}…`);
          } else if (msg.type === "done") {
            let text = `${msg.stopped ? "Stopped. " : "Done. "}${summary(msg, verb)}.`;
            if (!msg.checked) {
              text += " Nothing was listed — if My Activity wants you to sign in or verify, do it in its window and press again.";
            }
            status(text);
            resolve();
          }
        });
        port.onDisconnect.addListener(() => reject(new Error("The My Activity window went away")));
        port.postMessage({ op: "run", delete: doDelete, filters: filters(), delay: Number($("delay").value) || 1500 });
      });
    } catch (e) {
      status(e.message);
    } finally {
      try {
        port?.disconnect();
      } catch {
        // already gone
      }
      port = null;
      busy(false);
    }
  }

  $("find").addEventListener("click", () => run(false));
  $("delete").addEventListener("click", () => run(true));
  $("stop").addEventListener("click", () => port?.postMessage({ op: "stop" }));
  for (const radio of document.querySelectorAll('input[name="source"]')) {
    radio.addEventListener("change", () => {
      $("kind-row").style.display = source() === "youtube_comments" ? "" : "none";
    });
  }
})();
