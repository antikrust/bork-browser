/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Framework for injecting bork settings panes as first-class citizens of
 * about:preferences. Each pane lives in its own module under panes/ and is
 * registered from bork-panes.ts.
 *
 * The page's native machinery is used throughout: `register_module()` for
 * routing (an unregistered category THROWS in gotoPref — this is why the old
 * hub link deliberately routed nowhere), `search(category, "data-category")`
 * for pane switching, and the `Preferences` bindings for two-way pref sync on
 * `preference=` attributes. Pane content is appended eagerly so the built-in
 * text search can see it before first visit.
 *
 * Everything here runs inside the about:preferences window (injected by
 * NRAboutPreferencesChild via about-preferences.ts, chrome-privileged).
 */

export interface PrefsWindow extends Window {
  register_module?: (
    name: string,
    obj: { init: () => void; handleSubcategory?: (sub: string) => boolean },
  ) => void;
  gotoPref?: (hash?: string) => Promise<void>;
  Preferences?: {
    add: (opts: { id: string; type: string }) => unknown;
    get: (id: string) => unknown;
    queueUpdateOfAllElements: () => void;
  };
}

export const win = window as unknown as PrefsWindow;
export const doc = document!;

export const log = (...args: unknown[]) => console.log("[bork-panes]", ...args);

/* ------------------------------------------------------------------ */
/* Pane registration                                                   */
/* ------------------------------------------------------------------ */

export interface BorkPaneSpec {
  /** Internal category name — must start with "pane". */
  category: string;
  /** Element id for the category list item. */
  categoryId: string;
  /** Sidebar label. */
  label: string;
  /** data: URI or chrome: URL for the sidebar icon. */
  icon: string;
  /** Build the pane's content elements into the given root (which is
   * appended to #mainPrefPane with data-category set, hidden until shown). */
  build: (root: Element) => void;
  /** Called by the page framework the first time the pane is shown. */
  init?: () => void;
}

export function addBorkPane(spec: BorkPaneSpec): boolean {
  const categories = doc.getElementById("categories");
  const mainPrefPane = doc.getElementById("mainPrefPane");
  if (!categories || !mainPrefPane || !win.register_module) {
    log("preferences page structure missing; cannot add", spec.category);
    return false;
  }
  if (doc.getElementById(spec.categoryId)) return true; // idempotent

  // --- category nav button. FF151+ replaced the richlistbox with the
  // moz-page-nav custom element; its buttons carry view= (the category) and
  // iconsrc=, and their default activate() dispatches the change-view event
  // that gotoPref listens for — exactly what a real pane wants (the old hub
  // link overrode activate() precisely because it had no pane). ---
  const item = doc.createElement("moz-page-nav-button");
  item.id = spec.categoryId;
  item.setAttribute("view", spec.category);
  item.setAttribute("iconsrc", spec.icon);
  item.setAttribute("role", "none");
  item.textContent = spec.label;

  // Cluster bork categories above the hub link (while it still exists),
  // otherwise at the end of the list.
  const hubLink = doc.getElementById("category-nora-link");
  if (hubLink) categories.insertBefore(item, hubLink);
  else categories.appendChild(item);

  // --- pane content ---
  const root = doc.createXULElement("vbox");
  root.setAttribute("data-category", spec.category);
  (root as unknown as { hidden: boolean }).hidden = true;
  try {
    spec.build(root);
  } catch (e) {
    console.error("[bork-panes]", spec.category, "build failed:", e);
  }
  mainPrefPane.appendChild(root);

  // --- native routing ---
  let initted = false;
  win.register_module(spec.category, {
    init: () => {
      if (initted) return;
      initted = true;
      try {
        spec.init?.();
      } catch (e) {
        console.error("[bork-panes]", spec.category, "init failed:", e);
      }
    },
    handleSubcategory: () => false,
  });

  // Direct navigation on a cold load races our registration (the page's own
  // init runs gotoPref before this script adds the category and lands on a
  // fallback pane). Now that the category exists, honor the hash — in both
  // the internal form (#paneBorkX) and the friendly form the page itself
  // generates (#borkX = strip "pane", lowercase first letter).
  const friendly = spec.category.replace(/^pane/, "");
  const friendlyHash = `#${friendly.charAt(0).toLowerCase()}${friendly.slice(1)}`;
  if (location.hash === `#${spec.category}` || location.hash === friendlyHash) {
    win.gotoPref?.(`#${spec.category}`).catch(() => {});
  }

  return true;
}

/* ------------------------------------------------------------------ */
/* Element builders (XUL, native prefs look)                           */
/* ------------------------------------------------------------------ */

export function paneHeader(title: string, description: string): Element {
  const box = doc.createXULElement("hbox");
  box.className = "subcategory";
  box.setAttribute("hidden", "false");
  const h1 = doc.createElement("h1");
  h1.textContent = title;
  box.appendChild(h1);

  const wrap = doc.createXULElement("vbox");
  wrap.append(box);
  if (description) {
    const desc = doc.createElement("p");
    desc.className = "description-deemphasized";
    desc.textContent = description;
    wrap.appendChild(desc);
  }
  return wrap;
}

export function groupboxOf(title: string, children: Element[]): Element {
  const group = doc.createXULElement("groupbox");
  const label = doc.createXULElement("label");
  const h2 = doc.createElement("h2");
  h2.textContent = title;
  label.appendChild(h2);
  group.appendChild(label);
  for (const c of children) group.appendChild(c);
  return group;
}

export interface CheckboxSpec {
  id: string;
  label: string;
  description?: string;
  /** Bind natively to a bool pref via the page's Preferences framework
   * (add the pref with ensureBoolPref in the pane's init). */
  preference?: string;
  /** Manual binding: initial state + change handler. */
  checked?: () => boolean;
  onChange?: (checked: boolean) => void;
}

export function checkboxRow(spec: CheckboxSpec): Element {
  const row = doc.createXULElement("vbox");
  const cb = doc.createXULElement("checkbox");
  cb.id = spec.id;
  cb.setAttribute("label", spec.label);
  if (spec.preference) {
    cb.setAttribute("preference", spec.preference);
  } else {
    if (spec.checked) {
      try {
        (cb as unknown as { checked: boolean }).checked = spec.checked();
      } catch { /* default unchecked */ }
    }
    if (spec.onChange) {
      cb.addEventListener("command", () => {
        spec.onChange?.((cb as unknown as { checked: boolean }).checked);
      });
    }
  }
  row.appendChild(cb);
  if (spec.description) {
    const desc = doc.createElement("p");
    desc.className = "description-deemphasized";
    desc.style.marginInlineStart = "22px";
    desc.style.marginBlock = "0";
    desc.textContent = spec.description;
    row.appendChild(desc);
  }
  return row;
}

export interface RadioSpec {
  id: string;
  label: string;
  value: string;
}

/** Radio group with manual binding (for JSON-config or string prefs). */
export function radioGroup(
  id: string,
  options: RadioSpec[],
  current: () => string,
  onChange: (value: string) => void,
): Element {
  const group = doc.createXULElement("radiogroup");
  group.id = id;
  let cur = "";
  try {
    cur = current();
  } catch { /* leave unselected */ }
  for (const opt of options) {
    const radio = doc.createXULElement("radio");
    radio.id = opt.id;
    radio.setAttribute("label", opt.label);
    radio.setAttribute("value", opt.value);
    if (opt.value === cur) radio.setAttribute("selected", "true");
    group.appendChild(radio);
  }
  group.addEventListener("command", () => {
    const v = (group as unknown as { value: string }).value;
    try {
      onChange(v);
    } catch (e) {
      console.error("[bork-panes]", id, "radio change failed:", e);
    }
  });
  if (cur) (group as unknown as { value: string }).value = cur;
  return group;
}

export interface MenulistOption {
  label: string;
  value: string;
}

/** Dropdown with manual binding. */
export function menulistRow(
  id: string,
  label: string,
  options: MenulistOption[],
  current: () => string,
  onChange: (value: string) => void,
  description?: string,
): Element {
  const row = doc.createXULElement("vbox");
  const line = doc.createXULElement("hbox");
  line.setAttribute("align", "center");
  const lab = doc.createXULElement("label");
  lab.textContent = label;
  lab.setAttribute("flex", "1");
  const list = doc.createXULElement("menulist");
  list.id = id;
  const popup = doc.createXULElement("menupopup");
  for (const opt of options) {
    const mi = doc.createXULElement("menuitem");
    mi.setAttribute("label", opt.label);
    mi.setAttribute("value", opt.value);
    popup.appendChild(mi);
  }
  list.appendChild(popup);
  try {
    (list as unknown as { value: string }).value = current();
  } catch { /* leave default */ }
  list.addEventListener("command", () => {
    try {
      onChange((list as unknown as { value: string }).value);
    } catch (e) {
      console.error("[bork-panes]", id, "menulist change failed:", e);
    }
  });
  line.append(lab, list);
  row.appendChild(line);
  if (description) {
    const desc = doc.createElement("p");
    desc.className = "description-deemphasized";
    desc.style.marginBlock = "0";
    desc.textContent = description;
    row.appendChild(desc);
  }
  return row;
}

/** Plain button row. */
export function buttonRow(
  id: string,
  label: string,
  onCommand: () => void,
  description?: string,
): Element {
  const row = doc.createXULElement("hbox");
  row.setAttribute("align", "center");
  if (description) {
    const desc = doc.createElement("p");
    desc.className = "description-deemphasized";
    desc.style.marginBlock = "0";
    (desc.style as unknown as { flex: string }).flex = "1";
    desc.textContent = description;
    row.appendChild(desc);
    const spacer = doc.createXULElement("spacer");
    spacer.setAttribute("flex", "1");
    row.appendChild(spacer);
  }
  const btn = doc.createXULElement("button");
  btn.id = id;
  btn.setAttribute("label", label);
  btn.addEventListener("command", onCommand);
  row.appendChild(btn);
  return row;
}

/* ------------------------------------------------------------------ */
/* Pref helpers                                                        */
/* ------------------------------------------------------------------ */

/** Register a bool pref with the page's Preferences framework so elements
 * carrying preference= attributes bind natively. Safe to call repeatedly. */
export function ensureBoolPref(id: string): void {
  try {
    const prefs = win.Preferences;
    if (prefs && !prefs.get(id)) prefs.add({ id, type: "bool" });
  } catch (e) {
    console.error("[bork-panes] ensureBoolPref failed:", id, e);
  }
}

export function queuePrefsUpdate(): void {
  try {
    win.Preferences?.queueUpdateOfAllElements();
  } catch { /* page framework absent */ }
}

/** JSON-blob pref accessors (the hub stores grouped settings this way). */
export function readJsonPref(pref: string): Record<string, unknown> {
  try {
    return JSON.parse(Services.prefs.getStringPref(pref, "{}")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

export function writeJsonPrefField(
  pref: string,
  field: string,
  value: unknown,
): void {
  // Read-modify-write of the same JSON pref the hub's dataManager used, so
  // the consuming feature (which watches the pref) sees identical writes.
  const config = readJsonPref(pref);
  config[field] = value;
  Services.prefs.setStringPref(pref, JSON.stringify(config));
}
