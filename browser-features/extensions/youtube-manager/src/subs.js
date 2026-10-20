"use strict";
/**
 * Subscriptions: read the whole list, and subscribe to a list.
 *
 * Runs on youtube.com, top frame, because that is where the signed-in session
 * is. It talks to YouTube's own web API (/youtubei/v1) the way the page's
 * scripts do — the page's config for the client context, the SAPISID cookie
 * for the auth header — so there is no API key and no Google sign-in of its
 * own. The settings page drives it over a port (options.js, "ytm-subs").
 *
 * Requests go through content.fetch, Firefox's page-world fetch: an ordinary
 * content-script fetch carries the extension's origin, which the hash in the
 * Authorization header would not match.
 */
globalThis.YTCT = globalThis.YTCT || {};
(function (YTCT) {
  if (window.top !== window) return;
  if (location.pathname.startsWith("/live_chat")) return;

  const api = globalThis.browser ?? globalThis.chrome;
  const ORIGIN = "https://www.youtube.com";

  function pageCfg(key) {
    const page = window.wrappedJSObject || window;
    const cfg = page.ytcfg;
    if (!cfg || typeof cfg.get !== "function") return undefined;
    const value = cfg.get(key);
    // Objects belong to the page; a JSON round trip gives a copy of our own.
    return value && typeof value === "object"
      ? JSON.parse(page.JSON.stringify(value))
      : value;
  }

  function cookie(name) {
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
    return m ? m[1] : "";
  }

  async function sha1(text) {
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function innertube(endpoint, body) {
    const context = pageCfg("INNERTUBE_CONTEXT");
    if (!context) throw new Error("YouTube has not finished loading in this tab");
    const sapisid = cookie("SAPISID") || cookie("__Secure-3PAPISID");
    if (!sapisid) throw new Error("Not signed in to YouTube");
    const ts = Math.floor(Date.now() / 1000);
    const init = {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Authorization: `SAPISIDHASH ${ts}_${await sha1(`${ts} ${sapisid} ${ORIGIN}`)}`,
        "X-Origin": ORIGIN,
        "X-Goog-AuthUser": String(pageCfg("SESSION_INDEX") || 0),
        "X-Youtube-Client-Name": String(pageCfg("INNERTUBE_CONTEXT_CLIENT_NAME") || 1),
        "X-Youtube-Client-Version": String(pageCfg("INNERTUBE_CLIENT_VERSION") || ""),
      },
      body: JSON.stringify(Object.assign({ context }, body)),
    };
    const url = `${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`;
    const res = globalThis.content && typeof content.fetch === "function"
      ? await content.fetch(url, typeof cloneInto === "function" ? cloneInto(init, window, { cloneFunctions: false }) : init)
      : await fetch(url, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`YouTube said ${res.status} to ${endpoint}`);
    return JSON.parse(text);
  }

  /** Every channelRenderer and the next continuation token, wherever they sit. */
  function harvest(node, out) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) harvest(n, out);
      return;
    }
    const ch = node.channelRenderer;
    if (ch && ch.channelId) {
      const t = ch.title || {};
      const title = t.simpleText || (t.runs || []).map((r) => r.text).join("");
      const path = ch.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || "";
      out.channels.push({
        id: ch.channelId,
        title,
        url: path ? ORIGIN + path : `${ORIGIN}/channel/${ch.channelId}`,
      });
      return;
    }
    const cont = node.continuationItemRenderer;
    if (cont) {
      const token = cont.continuationEndpoint?.continuationCommand?.token;
      if (token) out.next = token;
      return;
    }
    for (const k in node) harvest(node[k], out);
  }

  /** The whole subscription list, page by page — the "All subscriptions" feed. */
  async function listAll(onPage) {
    const seen = new Map();
    let out = { channels: [], next: "" };
    harvest(await innertube("browse", { browseId: "FEchannels" }), out);
    for (let guard = 0; guard < 500; guard++) {
      for (const c of out.channels) if (!seen.has(c.id)) seen.set(c.id, c);
      if (onPage) onPage(seen.size);
      if (!out.next) break;
      const token = out.next;
      out = { channels: [], next: "" };
      harvest(await innertube("browse", { continuation: token }), out);
    }
    return [...seen.values()];
  }

  async function subscribe(id) {
    const r = await innertube("subscription/subscribe", { channelIds: [id] });
    // A refused subscribe still answers 200; success carries actions back.
    if (!r || !(r.actions || r.onResponseReceivedActions)) {
      throw new Error("not accepted");
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  api.runtime.onConnect.addListener((port) => {
    if (port.name !== "ytm-subs") return;
    let gone = false;
    let stopped = false;
    port.onDisconnect.addListener(() => (gone = stopped = true));
    const send = (msg) => {
      if (!gone) port.postMessage(msg);
    };
    // The settings page may have opened this tab a moment ago; it waits for
    // this before asking for anything.
    send({ type: "ready" });

    port.onMessage.addListener(async (msg) => {
      try {
        if (msg.op === "stop") {
          stopped = true;
          return;
        }
        if (msg.op === "list") {
          const channels = await listAll((n) => send({ type: "progress", text: `Read ${n} so far…` }));
          send({ type: "list", channels });
          return;
        }
        if (msg.op === "import") {
          send({ type: "progress", text: "Reading what you already subscribe to…" });
          const have = new Set((await listAll()).map((c) => c.id));
          const todo = (msg.channels || []).filter((c) => !have.has(c.id));
          const skipped = (msg.channels || []).length - todo.length;
          let done = 0;
          const failed = [];
          for (const c of todo) {
            if (stopped) break;
            try {
              await subscribe(c.id);
              done++;
            } catch (e) {
              failed.push({ ...c, error: e.message });
            }
            send({
              type: "progress",
              text: `Subscribed ${done} of ${todo.length}${failed.length ? `, ${failed.length} failed` : ""} — ${c.title || c.id}`,
            });
            // Paced like a person clicking, not a burst: a burst of
            // subscribes is the pattern YouTube rate-limits.
            await sleep(msg.delay || 1200);
          }
          send({ type: "imported", done, skipped, failed, stopped });
        }
      } catch (e) {
        send({ type: "error", text: e.message });
      }
    });
  });
})(globalThis.YTCT);
