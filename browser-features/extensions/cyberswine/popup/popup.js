"use strict";
(function () {
  const api = globalThis.browser ?? globalThis.chrome;
  const { store, match } = globalThis.FKOF;

  const $ = (id) => document.getElementById(id);

  store.load().then((config) => {
    $("count").textContent = `${config.stats.blocked} pages stopped`;
  });

  $("settings").addEventListener("click", async () => {
    await api.runtime.openOptionsPage();
    window.close();
  });

  $("block-this").addEventListener("click", async () => {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    const host = tab ? match.hostOf(tab.url) : "";
    if (!host) return;
    await api.runtime.sendMessage({ type: "fkof-block", host });
    window.close();
  });
})();
