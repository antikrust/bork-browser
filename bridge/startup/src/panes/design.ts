/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Appearance pane — port of the hub's design settings page
 * (pages-settings/src/app/design): interface options, tab bar position,
 * tab behavior, tab sleep exclusions and UI customization. derp ships a
 * single interface design, so there is no design picker — the Interface
 * group carries only the favicon-color toggle.
 *
 * Nearly everything lives in the floorp.design.configs JSON pref. Each
 * control read-modify-writes a single nested field, preserving every other
 * field — the same effective writes the hub's dataManager produced with its
 * object spreads. Two standalone bool prefs ride along, mirroring the hub's
 * defaults: floorp.splitView.dragToSplitCreate.enabled (default true) and
 * derp.tabs.hoverReload.enabled (default false). Tab sleep exclusions are
 * their own JSON pref, floorp.tabs.sleep.exclusion ({enabled, patterns}).
 *
 * The hub's engine sub-page (the userChrome.* toggles) was retired with the
 * design picker.
 *
 * Text mirrors the hub's en-US strings; i18n wiring is a follow-up for all
 * derp panes at once.
 */

import {
  addDerpPane,
  buttonRow,
  checkboxRow,
  doc,
  groupboxOf,
  log,
  paneHeader,
  radioGroup,
  readJsonPref,
} from "./framework.ts";

const DESIGN_PREF = "floorp.design.configs";

// Standalone prefs the hub's dataManager read/wrote next to the JSON blob.
const SPLIT_VIEW_DND_CREATE_PREF = "floorp.splitView.dragToSplitCreate.enabled";
const DEFAULT_SPLIT_VIEW_DND_CREATE = true;
const HOVER_RELOAD_PREF = "derp.tabs.hoverReload.enabled";
const DEFAULT_HOVER_RELOAD = false;

const TAB_SLEEP_EXCLUSION_PREF = "floorp.tabs.sleep.exclusion";

const RESTART_NOTE =
  "A restart of Derp is required to completely enable or disable this UI customization feature.";

/* ------------------------------------------------------------------ */
/* floorp.design.configs — nested field access                         */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function designValue(path: string[]): unknown {
  let node: unknown = readJsonPref(DESIGN_PREF);
  for (const key of path) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

function designBool(path: string[], fallback: boolean): boolean {
  const v = designValue(path);
  return typeof v === "boolean" ? v : fallback;
}

function designNumber(path: string[], fallback: number): number {
  const v = designValue(path);
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function designString(path: string[], fallback: string): string {
  const v = designValue(path);
  return typeof v === "string" ? v : fallback;
}

/** Read-modify-write one nested field of floorp.design.configs, preserving
 * every other field — the merge the hub's dataManager expressed with object
 * spreads. Missing intermediates are created (matching `...undefined` spread
 * semantics); a missing or unparsable pref is left untouched, like the hub's
 * save which bailed rather than seed a partial config. */
function setDesignValue(path: string[], value: unknown): void {
  let raw = "";
  try {
    raw = Services.prefs.getStringPref(DESIGN_PREF, "");
  } catch { /* treated as missing */ }
  if (!raw) {
    log("floorp.design.configs missing; not writing", path.join("."));
    return;
  }
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return;
    config = parsed;
  } catch {
    return;
  }
  let node = config;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (isRecord(next)) {
      node = next;
    } else {
      const fresh: Record<string, unknown> = {};
      node[key] = fresh;
      node = fresh;
    }
  }
  node[path[path.length - 1]] = value;
  Services.prefs.setStringPref(DESIGN_PREF, JSON.stringify(config));
}

/* ------------------------------------------------------------------ */
/* Local control builders                                              */
/* ------------------------------------------------------------------ */

function designCheckbox(
  id: string,
  path: string[],
  label: string,
  description?: string,
): Element {
  return checkboxRow({
    id,
    label,
    description,
    checked: () => designBool(path, false), // hub form defaults: unchecked
    onChange: (checked) => setDesignValue(path, checked),
  });
}

function prefCheckbox(
  id: string,
  pref: string,
  fallback: boolean,
  label: string,
): Element {
  return checkboxRow({
    id,
    label,
    checked: () => {
      try {
        return Services.prefs.getBoolPref(pref, fallback);
      } catch {
        return fallback;
      }
    },
    onChange: (checked) => {
      try {
        Services.prefs.setBoolPref(pref, checked);
      } catch (e) {
        console.error("[derp-panes]", id, "pref write failed:", e);
      }
    },
  });
}

function noteText(text: string): Element {
  const p = doc.createElement("p");
  p.className = "description-deemphasized";
  p.style.marginBlock = "0";
  p.textContent = text;
  return p;
}

function sectionHeader(title: string, description?: string): Element {
  const box = doc.createXULElement("vbox");
  const label = doc.createXULElement("label");
  label.setAttribute("style", "font-weight: 600; margin-block-start: 8px;");
  label.textContent = title;
  box.appendChild(label);
  if (description) box.appendChild(noteText(description));
  return box;
}

function labelLine(text: string): Element {
  const label = doc.createXULElement("label");
  label.textContent = text;
  return label;
}

interface NumberRowSpec {
  id: string;
  label: string;
  /** Range hint shown next to the input, e.g. "60px - 300px". */
  hint?: string;
  min?: number;
  max?: number;
  current: () => number | null;
  onChange: (value: number) => void;
  description?: string;
}

/** Labeled html input[type=number]; commits on change (blur/Enter). An
 * emptied field keeps the last saved value instead of writing 0 (the hub
 * saved Number("") === 0 there — a footgun, not a feature). */
function numberRow(spec: NumberRowSpec): Element {
  const row = doc.createXULElement("vbox");
  const line = doc.createXULElement("hbox");
  line.setAttribute("align", "center");
  const lab = doc.createXULElement("label");
  lab.setAttribute("flex", "1");
  lab.textContent = spec.label;
  line.appendChild(lab);
  if (spec.hint) {
    const hint = doc.createElement("span");
    hint.className = "description-deemphasized";
    hint.style.marginInlineEnd = "8px";
    hint.textContent = spec.hint;
    line.appendChild(hint);
  }
  const input = doc.createElement("input");
  input.type = "number";
  input.id = spec.id;
  if (spec.min !== undefined) input.min = String(spec.min);
  if (spec.max !== undefined) input.max = String(spec.max);
  input.style.width = "6em";
  try {
    const v = spec.current();
    if (typeof v === "number" && Number.isFinite(v)) input.value = String(v);
  } catch { /* leave empty */ }
  input.addEventListener("change", () => {
    if (input.value.trim() === "") return;
    const v = Number(input.value);
    if (!Number.isFinite(v)) return;
    try {
      spec.onChange(v);
    } catch (e) {
      console.error("[derp-panes]", spec.id, "number change failed:", e);
    }
  });
  line.appendChild(input);
  row.appendChild(line);
  if (spec.description) row.appendChild(noteText(spec.description));
  return row;
}

function setRowCheckboxDisabled(row: Element, disabled: boolean): void {
  const cb = row.querySelector("checkbox");
  if (!cb) return;
  if (disabled) cb.setAttribute("disabled", "true");
  else cb.removeAttribute("disabled");
}

/* ------------------------------------------------------------------ */
/* Tab sleep exclusion (floorp.tabs.sleep.exclusion)                   */
/* ------------------------------------------------------------------ */

interface SleepExclusionSettings {
  enabled: boolean;
  patterns: string[];
}

/** Mirror of the hub's getTabSleepExclusionSettings: missing/broken pref
 * falls back to {enabled: true, patterns: []}. */
function readSleepExclusion(): SleepExclusionSettings {
  try {
    const raw = Services.prefs.getStringPref(TAB_SLEEP_EXCLUSION_PREF, "");
    if (!raw) return { enabled: true, patterns: [] };
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data)) return { enabled: true, patterns: [] };
    return {
      enabled: typeof data.enabled === "boolean" ? data.enabled : true,
      patterns: Array.isArray(data.patterns)
        ? data.patterns.filter((p): p is string => typeof p === "string")
        : [],
    };
  } catch {
    return { enabled: true, patterns: [] };
  }
}

function writeSleepExclusion(settings: SleepExclusionSettings): void {
  // Same {enabled, patterns} shape the hub's save serialized.
  Services.prefs.setStringPref(
    TAB_SLEEP_EXCLUSION_PREF,
    JSON.stringify(settings),
  );
}

function sleepExclusionGroup(): Element {
  const initial = readSleepExclusion();

  const textarea = doc.createElement("textarea");
  textarea.id = "derp-design-sleep-patterns";
  textarea.rows = 6;
  textarea.placeholder = "Enter URL pattern (e.g., example.com, *.google.com)";
  textarea.style.width = "100%";
  textarea.style.boxSizing = "border-box";
  textarea.style.fontFamily = "monospace";
  textarea.style.marginBlock = "4px";
  textarea.value = initial.patterns.join("\n");

  const applyRow = buttonRow(
    "derp-design-sleep-apply",
    "Apply",
    () => {
      const patterns: string[] = [];
      for (const line of textarea.value.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !patterns.includes(trimmed)) patterns.push(trimmed);
      }
      writeSleepExclusion({ enabled: readSleepExclusion().enabled, patterns });
      textarea.value = patterns.join("\n");
    },
    "One pattern per line.",
  );

  const setEditorDisabled = (disabled: boolean) => {
    textarea.disabled = disabled;
    const btn = applyRow.querySelector("button");
    if (btn) {
      if (disabled) btn.setAttribute("disabled", "true");
      else btn.removeAttribute("disabled");
    }
  };

  const enabledRow = checkboxRow({
    id: "derp-design-sleep-enabled",
    label: "Enable tab sleep exclusion",
    checked: () => readSleepExclusion().enabled,
    onChange: (checked) => {
      writeSleepExclusion({
        enabled: checked,
        patterns: readSleepExclusion().patterns,
      });
      setEditorDisabled(!checked);
    },
  });
  setEditorDisabled(!initial.enabled);

  return groupboxOf("Tab Sleep Exclusion", [
    noteText(
      "Exclude specific websites from tab sleep (unloading). Tabs matching these patterns will remain active and won't be automatically unloaded when memory is low.",
    ),
    enabledRow,
    sectionHeader(
      "Exclusion Patterns",
      "Add URL patterns to exclude from tab sleep. Tabs matching these patterns will not be unloaded.",
    ),
    textarea,
    applyRow,
    sectionHeader("Pattern Examples"),
    noteText("example.com — Matches any URL containing this domain"),
    noteText("*.google.com — Matches all subdomains of google.com"),
    noteText("https://mail.google.com/* — Matches Gmail URLs only"),
  ]);
}

/* ------------------------------------------------------------------ */
/* Pane                                                                */
/* ------------------------------------------------------------------ */

function build(root: Element): void {
  root.appendChild(paneHeader(
    "Tab & Appearance",
    "Customize toolbar positions, tab bar style, and Derp's appearance.",
  ));

  /* ---- Interface ---- */
  root.appendChild(groupboxOf("Interface", [
    // Dark Derp is skin-level (data-derp-dark root attribute via
    // derp-defaults' pref observer), NOT an addon theme — this is its only
    // UI. Off = the normal Derp look. Takes effect instantly.
    prefCheckbox(
      "derp-design-dark-derp",
      "derp.theme.dark.enabled",
      false,
      "Dark Derp (black tab strip, panels and toolbar)",
    ),
    designCheckbox(
      "derp-design-favicon-color",
      ["globalConfigs", "faviconColor"],
      "Use Favicon Color for Navigation Bar Background",
    ),
  ]));

  /* ---- Tab Bar ---- */
  root.appendChild(groupboxOf("Tab Bar", [
    sectionHeader("Position", "Choose the tab bar position."),
    radioGroup(
      "derp-design-tabbar-position",
      [
        {
          id: "derp-design-tabbar-position-default",
          label: "Default",
          value: "default",
        },
        {
          id: "derp-design-tabbar-position-hide",
          label: "Hide Tab Bar",
          value: "hide-horizontal-tabbar",
        },
        {
          id: "derp-design-tabbar-position-below-navbar",
          label: "Show Tab Bar at Bottom of Navigation Bar",
          value: "bottom-of-navigation-toolbar",
        },
        {
          id: "derp-design-tabbar-position-window-bottom",
          label: "Show Tab Bar at Bottom of Window",
          value: "bottom-of-window",
        },
      ],
      () => designString(["tabbar", "tabbarPosition"], "default"),
      (value) => setDesignValue(["tabbar", "tabbarPosition"], value),
    ),
  ]));

  /* ---- Tabs ---- */
  const reverseScrollRow = designCheckbox(
    "derp-design-tab-scroll-reverse",
    ["tab", "tabScroll", "reverse"],
    "Reverse tab scroll",
  );
  const wrapScrollRow = designCheckbox(
    "derp-design-tab-scroll-wrap",
    ["tab", "tabScroll", "wrap"],
    "Loop tab scroll",
  );
  // The hub disabled the two dependent toggles while scroll-switching was
  // off (they only work when it is on).
  const syncScrollDependents = (enabled: boolean) => {
    setRowCheckboxDisabled(reverseScrollRow, !enabled);
    setRowCheckboxDisabled(wrapScrollRow, !enabled);
  };
  const scrollRow = checkboxRow({
    id: "derp-design-tab-scroll",
    label: "Switch tabs by scrolling",
    checked: () => designBool(["tab", "tabScroll", "enabled"], false),
    onChange: (checked) => {
      setDesignValue(["tab", "tabScroll", "enabled"], checked);
      syncScrollDependents(checked);
    },
  });
  syncScrollDependents(designBool(["tab", "tabScroll", "enabled"], false));

  root.appendChild(groupboxOf("Tabs", [
    sectionHeader(
      "Scroll",
      "Choose whether to use scrolling for tab switching and select scrolling behavior.",
    ),
    scrollRow,
    reverseScrollRow,
    wrapScrollRow,
    sectionHeader(
      "New tab opening position",
      "Specify where new tabs open. Following Firefox's behavior will vary the position based on how you open links.",
    ),
    radioGroup(
      "derp-design-tab-open-position",
      [
        {
          id: "derp-design-tab-open-default",
          label: "Follow Firefox's behavior",
          value: "-1",
        },
        {
          id: "derp-design-tab-open-last",
          label: "Open at the end of the tab bar",
          value: "0",
        },
        {
          id: "derp-design-tab-open-next",
          label: "Open next to the current tab",
          value: "1",
        },
      ],
      () => String(designNumber(["tab", "tabOpenPosition"], -1)),
      (value) => setDesignValue(["tab", "tabOpenPosition"], Number(value)),
    ),
    designCheckbox(
      "derp-design-tab-pin-title",
      ["tab", "tabPinTitle"],
      "Show pinned tab titles",
    ),
    prefCheckbox(
      "derp-design-tab-drag-split",
      SPLIT_VIEW_DND_CREATE_PREF,
      DEFAULT_SPLIT_VIEW_DND_CREATE,
      "Allow creating split view by dragging tabs",
    ),
    prefCheckbox(
      "derp-design-tab-hover-reload",
      HOVER_RELOAD_PREF,
      DEFAULT_HOVER_RELOAD,
      "Show a reload button when resting the pointer on a tab",
    ),
    designCheckbox(
      "derp-design-tab-double-click-close",
      ["tab", "tabDubleClickToClose"],
      "Close tab by double-clicking",
    ),
    numberRow({
      id: "derp-design-tab-min-width",
      label: "Minimum tab width",
      hint: "60px - 300px",
      min: 60,
      max: 300,
      current: () => designNumber(["tab", "tabMinWidth"], 76),
      onChange: (value) => setDesignValue(["tab", "tabMinWidth"], value),
    }),
    numberRow({
      id: "derp-design-tab-min-height",
      label: "Minimum tab height",
      hint: "20px - 100px",
      min: 20,
      max: 100,
      current: () => designNumber(["tab", "tabMinHeight"], 30),
      onChange: (value) => setDesignValue(["tab", "tabMinHeight"], value),
    }),
  ]));

  /* ---- Tab Sleep Exclusion ---- */
  root.appendChild(sleepExclusionGroup());

  /* ---- UI Customization ---- */
  // The hub only rendered this section while the (no longer selectable)
  // multirow tab bar style was active; mirror that.
  const multirowChildren: Element[] =
    designString(["tabbar", "tabbarStyle"], "horizontal") === "multirow"
      ? [
        sectionHeader("Multirow Tab"),
        designCheckbox(
          "derp-design-multirow-newtab-inside",
          ["uiCustomization", "multirowTab", "newtabInsideEnabled"],
          "Show new tab button inside tab bar",
        ),
      ]
      : [];

  root.appendChild(groupboxOf("UI Customization", [
    sectionHeader("Navigation Bar"),
    labelLine("Position (Experiment)"),
    radioGroup(
      "derp-design-navbar-position",
      [
        { id: "derp-design-navbar-position-top", label: "Top", value: "top" },
        {
          id: "derp-design-navbar-position-bottom",
          label: "Bottom",
          value: "bottom",
        },
      ],
      () => designString(["uiCustomization", "navbar", "position"], "top"),
      (value) =>
        setDesignValue(["uiCustomization", "navbar", "position"], value),
    ),
    noteText(RESTART_NOTE),
    designCheckbox(
      "derp-design-search-bar-top",
      ["uiCustomization", "navbar", "searchBarTop"],
      "Move page inside search bar",
    ),
    sectionHeader("Display"),
    designCheckbox(
      "derp-design-disable-fullscreen-notification",
      ["uiCustomization", "display", "disableFullscreenNotification"],
      "Disable fullscreen notification",
    ),
    designCheckbox(
      "derp-design-delete-browser-border",
      ["uiCustomization", "display", "deleteBrowserBorder"],
      "Round the corners of pages",
    ),
    designCheckbox(
      "derp-design-disable-qr-button",
      ["uiCustomization", "qrCode", "disableButton"],
      "Disable QR code button",
    ),
    sectionHeader("New Tab"),
    designCheckbox(
      "derp-design-disable-floorp-start",
      ["uiCustomization", "disableFloorpStart"],
      "Disable Derp Start",
      RESTART_NOTE,
    ),
    sectionHeader("Special Features"),
    designCheckbox(
      "derp-design-optimize-tst",
      ["uiCustomization", "special", "optimizeForTreeStyleTab"],
      "Optimize for Tree Style Tab",
    ),
    designCheckbox(
      "derp-design-hide-nav-buttons",
      ["uiCustomization", "special", "hideForwardBackwardButton"],
      "Hide Forward/Backward Button",
    ),
    designCheckbox(
      "derp-design-stg-workspaces",
      ["uiCustomization", "special", "stgLikeWorkspaces"],
      "Simple Tab Groups like workspaces",
    ),
    sectionHeader("Bookmark Bar"),
    labelLine("Position (Experiment)"),
    radioGroup(
      "derp-design-bookmark-bar-position",
      [
        {
          id: "derp-design-bookmark-bar-position-top",
          label: "Top",
          value: "top",
        },
        {
          id: "derp-design-bookmark-bar-position-bottom",
          label: "Bottom",
          value: "bottom",
        },
      ],
      () => designString(["uiCustomization", "bookmarkBar", "position"], "top"),
      (value) =>
        setDesignValue(["uiCustomization", "bookmarkBar", "position"], value),
    ),
    designCheckbox(
      "derp-design-bookmark-bar-focus-expand",
      ["uiCustomization", "bookmarkBar", "focusExpand"],
      "Expand bookmark bar on focus",
    ),
    ...multirowChildren,
  ]));
}

const ICON = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="context-fill" fill-opacity="context-fill-opacity"><path fill-rule="evenodd" d="M8 2C4.69 2 2 4.69 2 8s2.69 6 6 6c.55 0 1-.45 1-1 0-.26-.1-.49-.26-.67-.15-.18-.24-.41-.24-.66 0-.55.45-1 1-1h1.17c1.84 0 3.33-1.5 3.33-3.34C14 4.39 11.31 2 8 2zM4.33 8a1 1 0 1 1 0-2 1 1 0 1 1 0 2zm2-2.67a1 1 0 1 1 0-2 1 1 0 1 1 0 2zm3.34 0a1 1 0 1 1 0-2 1 1 0 1 1 0 2zm2 2.67a1 1 0 1 1 0-2 1 1 0 1 1 0 2z"/></svg>`,
);

export function registerDesignPane(): void {
  const ok = addDerpPane({
    category: "paneDerpDesign",
    categoryId: "category-derp-design",
    label: "Tab & Appearance",
    icon: ICON,
    build,
  });
  log("design pane:", ok ? "registered" : "FAILED");
}
