"use strict";
/**
 * Settings. Everything auto-saves — a Save button on a page of checkboxes is a
 * way to lose edits, not to protect them.
 */
(function () {
  const { store, match, outlets } = globalThis.FKOF;

  const $ = (id) => document.getElementById(id);
  const CHECKBOXES = ["enabled", "blockNav", "hideCards", "showButton"];

  let config = null;
  let savedTimer = 0;

  function flashSaved() {
    const el = $("saved");
    el.classList.add("show");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => el.classList.remove("show"), 1200);
  }

  async function persist() {
    await store.save(config);
    flashSaved();
  }

  /* ------------------------------------------------------------------ render */

  function render() {
    for (const id of CHECKBOXES) $(id).checked = !!config[id];
    renderOutlets();
    renderCustom();
  }

  function renderOutlets() {
    const list = $("outlets");
    list.textContent = "";
    const allowed = new Set(config.allowed || []);

    for (const outlet of outlets) {
      const li = document.createElement("li");

      const head = document.createElement("div");
      head.className = "head";

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = outlet.name;

      const domains = document.createElement("span");
      domains.className = "domains";
      domains.textContent = outlet.domains.join(" ");

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = !allowed.has(outlet.key);
      toggle.title = "Blocked";
      toggle.addEventListener("change", async () => {
        config.allowed = toggle.checked
          ? (config.allowed || []).filter((k) => k !== outlet.key)
          : [...(config.allowed || []), outlet.key];
        await persist();
      });

      head.append(name, domains, toggle);

      const owner = document.createElement("p");
      owner.className = "owner";
      owner.textContent = outlet.ownerAsOf
        ? `${outlet.owner} (as of ${outlet.ownerAsOf})`
        : outlet.owner;

      li.append(head, owner);
      list.appendChild(li);
    }
  }

  function renderCustom() {
    const list = $("custom");
    list.textContent = "";
    const sorted = (config.custom || [])
      .slice()
      .sort((a, b) => (b.at || 0) - (a.at || 0));

    for (const entry of sorted) {
      const li = document.createElement("li");

      const head = document.createElement("div");
      head.className = "head";

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = entry.domain;

      const when = document.createElement("span");
      when.className = "domains";
      when.textContent = entry.at ? new Date(entry.at).toLocaleDateString() : "";

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "unblock";
      remove.textContent = "unblock";
      remove.addEventListener("click", async () => {
        const key = match.normalizeHost(entry.domain);
        config.custom = config.custom.filter(
          (e) => match.normalizeHost(e.domain) !== key,
        );
        renderCustom();
        await persist();
      });

      head.append(name, when, remove);
      li.appendChild(head);
      list.appendChild(li);
    }

    $("custom-empty").style.display = sorted.length ? "none" : "";
  }

  /* ------------------------------------------------------------------ wiring */

  function wire() {
    for (const id of CHECKBOXES) {
      $(id).addEventListener("change", async (event) => {
        config[id] = event.target.checked;
        await persist();
      });
    }

    $("add").addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = $("domain");
      // Paste a whole URL and we take the domain out of it.
      const domain = match.normalizeHost(
        match.hostOf(input.value.trim(), "https://x.invalid/") ||
          input.value.trim(),
      );
      if (!domain) return;
      if (
        !(config.custom || []).some(
          (e) => match.normalizeHost(e.domain) === domain,
        )
      ) {
        config.custom.push({ domain, name: domain, at: Date.now() });
      }
      input.value = "";
      renderCustom();
      await persist();
    });

    $("export").addEventListener("click", async () => {
      const payload = JSON.stringify(
        { allowed: config.allowed, custom: config.custom },
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
      } catch {
        $("io").value = "That is not valid JSON.";
        return;
      }
      if (Array.isArray(parsed.allowed)) config.allowed = parsed.allowed.map(String);
      if (Array.isArray(parsed.custom)) {
        config.custom = parsed.custom
          .map((e) => (typeof e === "string" ? { domain: e, at: Date.now() } : e))
          .filter((e) => e && e.domain);
      }
      render();
      await persist();
    });
  }

  store.load().then((loaded) => {
    config = loaded;
    render();
    wire();
    store.onChange((next) => {
      config = next;
      render();
    });
  });
})();
