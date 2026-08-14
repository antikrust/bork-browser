"use strict";
/** Toolbar popup: the two switches worth reaching for mid-stream, and a quick rule box. */
(function () {
  const { store } = globalThis.YTCT;
  const api = globalThis.browser ?? globalThis.chrome;
  const $ = (id) => document.getElementById(id);

  store.load().then((config) => {
    $("enabled").checked = !!config.enabled;
    $("threads").checked = !!config.threads;
    $("counts").textContent =
      `${config.words.length} rule${config.words.length === 1 ? "" : "s"} · ` +
      `${config.authors.length} blocked`;

    $("enabled").addEventListener("change", async (event) => {
      await store.update((cfg) => {
        cfg.enabled = event.target.checked;
        return cfg;
      });
    });

    $("threads").addEventListener("change", async (event) => {
      await store.update((cfg) => {
        cfg.threads = event.target.checked;
        return cfg;
      });
    });

    $("quick").addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = $("word").value.trim();
      if (!value) return;
      await store.update((cfg) => {
        if (!cfg.words.includes(value)) cfg.words.push(value);
        return cfg;
      });
      $("word").value = "";
      const updated = await store.load();
      $("counts").textContent =
        `${updated.words.length} rule${updated.words.length === 1 ? "" : "s"} · ` +
        `${updated.authors.length} blocked`;
    });

    $("settings").addEventListener("click", () => {
      api.tabs
        ? api.tabs.create({ url: api.runtime.getURL("options/options.html") })
        : globalThis.open(api.runtime.getURL("options/options.html"), "_blank");
      globalThis.close();
    });
  });
})();
