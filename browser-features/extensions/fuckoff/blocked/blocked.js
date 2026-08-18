"use strict";
/**
 * The page you land on instead of theirs. Reads the outlet out of the bundle
 * (or the user's own list) and lays out what is known about it.
 */
(function () {
  const api = globalThis.browser ?? globalThis.chrome;
  const { store, match, outlets } = globalThis.FKOF;

  const params = new URLSearchParams(location.search);
  const host = params.get("host") || "";
  const target = params.get("u") || "";
  const $ = (id) => document.getElementById(id);

  $("host").textContent = target || host;

  function hide(id) {
    $(id).style.display = "none";
  }

  function fill(outlet) {
    if (!outlet) {
      $("name").textContent = host;
      hide("owner-box");
      hide("record-box");
      hide("sources-box");
      hide("note-box");
      return;
    }

    $("name").textContent = outlet.name || host;

    if (outlet.owner) {
      $("owner").textContent = outlet.owner;
      $("asof").textContent = outlet.ownerAsOf
        ? `Ownership as of ${outlet.ownerAsOf}. Newspapers change hands — check before you quote this.`
        : "";
    } else {
      hide("owner-box");
    }

    if (outlet.record && outlet.record.length) {
      for (const item of outlet.record) {
        const li = document.createElement("li");
        li.textContent = item;
        $("record").appendChild(li);
      }
    } else {
      hide("record-box");
    }

    if (outlet.sources && outlet.sources.length) {
      for (const source of outlet.sources) {
        const li = document.createElement("li");
        const [url, ...rest] = String(source).split(" — ");
        const a = document.createElement("a");
        a.href = url;
        a.textContent = rest.length ? rest.join(" — ") : url;
        a.rel = "noreferrer";
        li.appendChild(a);
        $("sources").appendChild(li);
      }
    } else {
      hide("sources-box");
    }

    if (outlet.note) $("note").textContent = outlet.note;
    else hide("note-box");
  }

  /* ------------------------------------------------------------------ wiring */

  $("back").addEventListener("click", () => {
    // history.back() lands back on the page that linked here; if this tab
    // opened straight onto the blocked URL there is nothing behind it.
    if (history.length > 1) history.back();
    else location.href = "about:blank";
  });

  $("pass").addEventListener("click", async () => {
    await api.runtime.sendMessage({ type: "fkof-pass", host });
    location.href = target || `https://${host}/`;
  });

  $("unblock").addEventListener("click", async () => {
    await api.runtime.sendMessage({ type: "fkof-unblock", host });
    location.href = target || `https://${host}/`;
  });

  $("settings").addEventListener("click", (event) => {
    event.preventDefault();
    api.runtime.openOptionsPage();
  });

  store.load().then((config) => {
    fill(match.lookup(host, match.buildIndex(config, outlets)));
  });
})();
