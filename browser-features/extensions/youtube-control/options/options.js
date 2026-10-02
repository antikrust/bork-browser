"use strict";
/**
 * Settings page.
 *
 * Everything auto-saves on change — a Save button on a page whose whole job is
 * toggling six checkboxes is a way to lose edits, not to protect them. The
 * content script re-reads and re-applies on every write, so an open chat updates
 * as you type.
 */
(function () {
  const { store, filters } = globalThis.YTCT;

  const $ = (id) => document.getElementById(id);
  const CHECKBOXES = [
    "enabled",
    "wholeWord",
    "caseSensitive",
    "matchAuthorNames",
    "protectStaff",
    "showButton",
    "threads",
    "bumpThreads",
  ];

  let config = null;
  let savingTimer = 0;


  function flashSaved() {
    const el = $("saved");
    el.classList.add("show");
    clearTimeout(savingTimer);
    savingTimer = setTimeout(() => el.classList.remove("show"), 1200);
  }

  async function persist() {
    await store.save(config);
    flashSaved();
  }

  /* ------------------------------------------------------------------ render */

  function render() {
    for (const id of CHECKBOXES) $(id).checked = !!config[id];
    $("hideMode").value = config.hideMode;
    $("repeatLimit").value = String(config.repeatLimit);
    if (document.activeElement !== $("words")) {
      $("words").value = config.words.join("\n");
    }
    if (document.activeElement !== $("banWords")) {
      $("banWords").value = config.banWords.join("\n");
    }
    renderRuleErrors();
    renderBlocklist("authors", "authors-empty", "authors");
    renderBlocklist("channels", "channels-empty", "channels");
  }

  function renderRuleErrors() {
    showErrors("rule-errors", config.words);
    showErrors("ban-errors", config.banWords);
  }

  function showErrors(boxId, words) {
    const box = $(boxId);
    box.textContent = "";
    const broken = filters.compile(words, config).filter((r) => r.error);
    for (const rule of broken) {
      const line = document.createElement("div");
      line.textContent = `${rule.src} — ${rule.error}`;
      box.appendChild(line);
    }
  }

  /** Authors and channels render identically: name, why · when, unblock. */
  function renderBlocklist(listId, emptyId, configKey) {
    const list = $(listId);
    list.textContent = "";
    const sorted = config[configKey]
      .slice()
      .sort((a, b) => (b.at || 0) - (a.at || 0));

    for (const entry of sorted) {
      const li = document.createElement("li");

      const name = document.createElement("span");
      name.className = "author-name";
      name.textContent = entry.name;

      const meta = document.createElement("span");
      meta.className = "author-meta";
      // The separator only earns its place between two things. Entries that
      // shipped with the extension carry no date — nothing happened on a day —
      // and used to render as "shipped with the extension · " on every row.
      const when = entry.at ? new Date(entry.at).toLocaleDateString() : "";
      meta.textContent = [entry.why, when].filter(Boolean).join(" · ");
      meta.title = entry.why || "";

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "unblock";
      remove.textContent = "unblock";
      remove.addEventListener("click", async () => {
        const key = filters.normalizeName(entry.name);
        config[configKey] = config[configKey].filter(
          (e) => filters.normalizeName(e.name) !== key,
        );
        renderBlocklist(listId, emptyId, configKey);
        await persist();
      });

      li.append(name, meta, remove);
      list.appendChild(li);
    }
    $(emptyId).style.display = sorted.length ? "none" : "";
  }

  /* ------------------------------------------------------------------ wiring */

  /** Debounced textarea -> config list. Both rule lists behave identically. */
  function wireList(elementId, configKey) {
    let timer = 0;
    $(elementId).addEventListener("input", (event) => {
      clearTimeout(timer);
      // Debounced: every keystroke would otherwise be a storage write that the
      // content script answers with a full rescan of the visible chat.
      timer = setTimeout(async () => {
        config[configKey] = event.target.value
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        renderRuleErrors();
        await persist();
      }, 400);
    });
  }

  function wire() {
    for (const id of CHECKBOXES) {
      $(id).addEventListener("change", async (event) => {
        config[id] = event.target.checked;
        await persist();
      });
    }

    $("hideMode").addEventListener("change", async (event) => {
      config.hideMode = event.target.value;
      await persist();
    });

    $("repeatLimit").addEventListener("change", async (event) => {
      const value = Number.parseInt(event.target.value, 10);
      config.repeatLimit = Number.isFinite(value) && value >= 0 ? value : 0;
      event.target.value = String(config.repeatLimit);
      await persist();
    });

    wireList("words", "words");
    wireList("banWords", "banWords");

    $("add-author").addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = $("author-input");
      const name = input.value.trim();
      if (!name) return;
      const key = filters.normalizeName(name);
      if (!config.authors.some((a) => filters.normalizeName(a.name) === key)) {
        config.authors.push({ name, at: Date.now(), auto: false });
      }
      input.value = "";
      renderBlocklist("authors", "authors-empty", "authors");
      await persist();
    });

    $("add-channel").addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = $("channel-input");
      const name = input.value.trim();
      if (!name) return;
      const key = filters.normalizeName(name);
      if (!config.channels.some((c) => filters.normalizeName(c.name) === key)) {
        config.channels.push({ name, at: Date.now(), why: "added by hand" });
      }
      input.value = "";
      renderBlocklist("channels", "channels-empty", "channels");
      await persist();
    });

    $("export").addEventListener("click", async () => {
      const payload = JSON.stringify(
        {
          words: config.words,
          banWords: config.banWords,
          authors: config.authors,
          channels: config.channels,
        },
        null,
        2,
      );
      $("io").value = payload;
      try {
        await navigator.clipboard.writeText(payload);
        flashSaved();
      } catch {
        // Clipboard permission can be refused; the textarea still has it.
      }
    });

    $("import").addEventListener("click", async () => {
      const raw = $("io").value.trim();
      if (!raw) return;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        $("rule-errors").textContent = `Import failed: ${error.message}`;
        return;
      }
      if (Array.isArray(parsed.words)) config.words = parsed.words.map(String);
      if (Array.isArray(parsed.banWords)) config.banWords = parsed.banWords.map(String);
      if (Array.isArray(parsed.authors)) {
        config.authors = parsed.authors
          .map((a) => (typeof a === "string" ? { name: a, at: Date.now() } : a))
          .filter((a) => a && a.name);
      }
      if (Array.isArray(parsed.channels)) {
        config.channels = parsed.channels
          .map((c) => (typeof c === "string" ? { name: c, at: Date.now() } : c))
          .filter((c) => c && c.name);
      }
      render();
      await persist();
    });
  }

  store.load().then((loaded) => {
    config = loaded;
    render();
    wire();
    // Another tab (or the SHUT UP button in a live chat) may write while this
    // page is open; keep it truthful rather than stale.
    store.onChange((next) => {
      config = next;
      render();
    });
  });
})();
