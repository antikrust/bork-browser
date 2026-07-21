/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Mouse Gestures pane — port of the hub's gesture settings page
 * (pages-settings/src/app/gesture): the enable switch lives in the
 * floorp.mousegesture.enabled bool pref; every other setting lives in the
 * floorp.mousegesture.config JSON pref. Writes reproduce the hub
 * dataManager's semantics: read the pref, apply the change to the full
 * (defaults-filled) config object, write the whole object back — with
 * `enabled` never written into the JSON blob, exactly as the hub stripped
 * it before saving.
 *
 * The action list mirrors the hub's GESTURE_ACTIONS
 * (pages-settings/src/app/gesture/useAvailableActions.ts) — the
 * settings-facing view of the mouse-gesture feature's action registry
 * (chrome/common/mouse-gesture/utils/actions.ts). Text mirrors the hub's
 * en-US strings; i18n wiring is a follow-up for all derp panes at once.
 */

import {
  addDerpPane,
  checkboxRow,
  doc,
  ensureBoolPref,
  groupboxOf,
  log,
  menulistRow,
  paneHeader,
  queuePrefsUpdate,
  readJsonPref,
} from "./framework.ts";

const ENABLED_PREF = "floorp.mousegesture.enabled";
const CONFIG_PREF = "floorp.mousegesture.config";

/* ------------------------------------------------------------------ */
/* Config model (mirrors the hub dataManager's shape and defaults)     */
/* ------------------------------------------------------------------ */

type GestureDirection =
  | "up"
  | "down"
  | "left"
  | "right"
  | "upRight"
  | "upLeft"
  | "downRight"
  | "downLeft";

interface GestureAction {
  pattern: GestureDirection[];
  action: string;
}

interface GestureConfig {
  rockerGesturesEnabled: boolean;
  wheelGesturesEnabled: boolean;
  sensitivity: number;
  showTrail: boolean;
  showLabel: boolean;
  trailColor: string;
  trailWidth: number;
  contextMenu: { minDistance: number; preventionTimeout: number };
  actions: GestureAction[];
  rockerActions: { leftRight: string; rightLeft: string };
}

const DIRECTIONS: readonly GestureDirection[] = [
  "up",
  "down",
  "left",
  "right",
  "upRight",
  "upLeft",
  "downRight",
  "downLeft",
];

const ARROWS: Record<GestureDirection, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  upRight: "↗",
  upLeft: "↖",
  downRight: "↘",
  downLeft: "↙",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Defaults exactly as the hub's dataManager filled them in on load. */
function configView(raw: Record<string, unknown>): GestureConfig {
  const cm = isRecord(raw.contextMenu) ? raw.contextMenu : {};
  const ra = isRecord(raw.rockerActions) ? raw.rockerActions : {};
  return {
    rockerGesturesEnabled: typeof raw.rockerGesturesEnabled === "boolean"
      ? raw.rockerGesturesEnabled
      : true,
    wheelGesturesEnabled: typeof raw.wheelGesturesEnabled === "boolean"
      ? raw.wheelGesturesEnabled
      : true,
    sensitivity: typeof raw.sensitivity === "number" ? raw.sensitivity : 40,
    showTrail: typeof raw.showTrail === "boolean" ? raw.showTrail : true,
    showLabel: typeof raw.showLabel === "boolean" ? raw.showLabel : true,
    trailColor: typeof raw.trailColor === "string" ? raw.trailColor : "#37ff00",
    trailWidth: typeof raw.trailWidth === "number" ? raw.trailWidth : 6,
    contextMenu: {
      minDistance: typeof cm.minDistance === "number" ? cm.minDistance : 12,
      preventionTimeout: typeof cm.preventionTimeout === "number"
        ? cm.preventionTimeout
        : 200,
    },
    actions: Array.isArray(raw.actions)
      ? (raw.actions as GestureAction[])
      : [],
    rockerActions: {
      leftRight: typeof ra.leftRight === "string"
        ? ra.leftRight
        : "gecko-forward",
      rightLeft: typeof ra.rightLeft === "string" ? ra.rightLeft : "gecko-back",
    },
  };
}

function readConfig(): GestureConfig {
  return configView(readJsonPref(CONFIG_PREF));
}

/** Read-modify-write of the same JSON pref the hub's dataManager wrote:
 * the full config object goes back (unknown fields preserved), and
 * `enabled` is stripped — the hub kept it only in the bool pref. */
function writeConfig(mutate: (config: GestureConfig) => void): void {
  const raw = readJsonPref(CONFIG_PREF);
  const view = configView(raw);
  mutate(view);
  const out: Record<string, unknown> = { ...raw, ...view };
  delete out.enabled;
  Services.prefs.setStringPref(CONFIG_PREF, JSON.stringify(out));
}

/* ------------------------------------------------------------------ */
/* Action list (mirrors the hub's GESTURE_ACTIONS + en-US labels)      */
/* ------------------------------------------------------------------ */

interface ActionOption {
  id: string;
  label: string;
}

const ACTIONS: readonly ActionOption[] = [
  { id: "gecko-back", label: "Go Back" },
  { id: "gecko-forward", label: "Go Forward" },
  { id: "gecko-reload", label: "Reload" },
  { id: "gecko-close-tab", label: "Close Tab" },
  { id: "gecko-close-other-tabs", label: "Close Other Tabs" },
  { id: "gecko-close-tabs-to-start", label: "Close Tabs to Left" },
  { id: "gecko-close-tabs-to-end", label: "Close Tabs to Right" },
  { id: "gecko-open-new-tab", label: "New Tab" },
  { id: "gecko-duplicate-tab", label: "Duplicate Tab" },
  { id: "gecko-reload-all-tabs", label: "Reload All Tabs" },
  { id: "gecko-restore-last-tab", label: "Reopen Closed Tab" },
  { id: "gecko-open-new-window", label: "Open New Window" },
  { id: "gecko-open-new-private-window", label: "Open New Private Window" },
  { id: "gecko-close-window", label: "Close Window" },
  { id: "gecko-restore-last-window", label: "Restore Last Window" },
  { id: "gecko-show-next-tab", label: "Show Next Tab" },
  { id: "gecko-show-previous-tab", label: "Show Previous Tab" },
  {
    id: "gecko-show-previously-selected-tab",
    label: "Show Previously Selected Tab",
  },
  { id: "gecko-show-all-tabs-panel", label: "Show All Tabs Panel" },
  { id: "gecko-force-reload", label: "Force Reload" },
  { id: "gecko-zoom-in", label: "Zoom In" },
  { id: "gecko-zoom-out", label: "Zoom Out" },
  { id: "gecko-reset-zoom", label: "Reset Zoom" },
  { id: "gecko-bookmark-this-page", label: "Bookmark This Page" },
  { id: "gecko-open-home-page", label: "Open Home Page" },
  { id: "gecko-open-addons-manager", label: "Open Addons Manager" },
  { id: "gecko-send-with-mail", label: "Send With Mail" },
  { id: "gecko-save-page", label: "Save Page" },
  { id: "gecko-print-page", label: "Print Page" },
  { id: "gecko-mute-current-tab", label: "Mute Current Tab" },
  { id: "gecko-show-source-of-page", label: "Show Source Of Page" },
  { id: "gecko-show-page-info", label: "Show Page Info" },
  { id: "floorp-rest-mode", label: "Enable Rest Mode" },
  { id: "floorp-hide-user-interface", label: "Hide Interface" },
  { id: "floorp-toggle-navigation-panel", label: "Toggle Navigation Panel" },
  { id: "gecko-stop", label: "Stop" },
  { id: "gecko-search-in-this-page", label: "Search In This Page" },
  { id: "gecko-show-next-search-result", label: "Show Next Search Result" },
  {
    id: "gecko-show-previous-search-result",
    label: "Show Previous Search Result",
  },
  { id: "gecko-search-the-web", label: "Search The Web" },
  { id: "gecko-open-migration-wizard", label: "Open Migration Wizard" },
  { id: "gecko-quit-from-application", label: "Quit Application" },
  { id: "gecko-enter-into-customize-mode", label: "Enter Customize Mode" },
  { id: "gecko-enter-into-offline-mode", label: "Enter Offline Mode" },
  { id: "gecko-open-screen-capture", label: "Open Screen Capture" },
  { id: "floorp-show-pip", label: "Show Picture-in-Picture" },
  { id: "gecko-open-bookmark-add-tool", label: "Open Bookmark Add Tool" },
  { id: "gecko-open-bookmarks-manager", label: "Open Bookmarks Manager" },
  { id: "gecko-toggle-bookmark-toolbar", label: "Toggle Bookmark Toolbar" },
  { id: "gecko-open-general-preferences", label: "Open General Preferences" },
  { id: "gecko-open-privacy-preferences", label: "Open Privacy Preferences" },
  {
    id: "gecko-open-workspaces-preferences",
    label: "Open Workspaces Preferences",
  },
  {
    id: "gecko-open-containers-preferences",
    label: "Open Containers Preferences",
  },
  { id: "gecko-open-search-preferences", label: "Open Search Preferences" },
  { id: "gecko-open-sync-preferences", label: "Open Sync Preferences" },
  { id: "gecko-open-task-manager", label: "Open Task Manager" },
  { id: "gecko-forget-history", label: "Forget History" },
  { id: "gecko-quick-forget-history", label: "Quick Forget History" },
  { id: "gecko-restore-last-session", label: "Restore Last Session" },
  { id: "gecko-search-history", label: "Search History" },
  { id: "gecko-manage-history", label: "Manage History" },
  { id: "gecko-open-downloads", label: "Open Downloads" },
  { id: "gecko-show-bookmark-sidebar", label: "Show Bookmark Sidebar" },
  { id: "gecko-show-history-sidebar", label: "Show History Sidebar" },
  { id: "gecko-show-synced-tabs-sidebar", label: "Show Synced Tabs Sidebar" },
  { id: "gecko-hide-sidebar", label: "Hide Sidebar" },
  { id: "gecko-toggle-sidebar", label: "Toggle Sidebar" },
  { id: "gecko-scroll-line-up", label: "Scroll Up" },
  { id: "gecko-scroll-line-down", label: "Scroll Down" },
  { id: "gecko-scroll-up", label: "Scroll Up" },
  { id: "gecko-scroll-down", label: "Scroll Down" },
  { id: "gecko-scroll-right", label: "Scroll Right" },
  { id: "gecko-scroll-left", label: "Scroll Left" },
  { id: "gecko-scroll-to-top", label: "Scroll to Top" },
  { id: "gecko-scroll-to-bottom", label: "Scroll to Bottom" },
  { id: "gecko-workspace-next", label: "Switch to Next Workspace" },
  { id: "gecko-workspace-previous", label: "Switch to Previous Workspace" },
  { id: "floorp-toggle-zen-mode", label: "Toggle Zen Mode" },
  { id: "floorp-toggle-command-palette", label: "Toggle Command Palette" },
  { id: "floorp-open-settings", label: "Open Settings" },
  { id: "floorp-open-hub", label: "Open Derp Hub" },
  { id: "floorp-toggle-share-mode", label: "Toggle Share Mode" },
  {
    id: "floorp-copy-page-url-as-markdown",
    label: "Copy Page URL as Markdown",
  },
  { id: "floorp-split-view-open-left", label: "Split View Left" },
  { id: "floorp-split-view-open-right", label: "Split View Right" },
  { id: "floorp-split-view-open-top", label: "Split View Top" },
  { id: "floorp-split-view-open-bottom", label: "Split View Bottom" },
  { id: "floorp-split-view-close", label: "Close Split View" },
  { id: "floorp-split-view-swap-panes", label: "Swap Split Panes" },
  { id: "floorp-split-view-cycle-layout", label: "Cycle Split Layout" },
  { id: "floorp-split-view-add-pane", label: "Add Pane to Split View" },
  {
    id: "floorp-split-view-remove-pane",
    label: "Remove Pane from Split View",
  },
];

/* ------------------------------------------------------------------ */
/* Enabled-state gating (hub greys controls out while the feature is   */
/* off; existing mapping rows stay interactive, exactly like the hub)  */
/* ------------------------------------------------------------------ */

interface GatedControl {
  el: Element;
  extra?: (config: GestureConfig) => boolean;
}

const gated: GatedControl[] = [];

function setDisabled(el: Element, disabled: boolean): void {
  if (el instanceof HTMLInputElement) {
    el.disabled = disabled;
    return;
  }
  if (disabled) el.setAttribute("disabled", "true");
  else el.removeAttribute("disabled");
}

function refreshDisabled(): void {
  const on = Services.prefs.getBoolPref(ENABLED_PREF, false);
  const config = readConfig();
  for (const { el, extra } of gated) {
    setDisabled(el, !on || (extra ? !extra(config) : false));
  }
}

/* ------------------------------------------------------------------ */
/* Element builders                                                    */
/* ------------------------------------------------------------------ */

function deemphasized(text: string): HTMLParagraphElement {
  const p = doc.createElement("p");
  p.className = "description-deemphasized";
  p.style.marginBlock = "0";
  p.textContent = text;
  return p;
}

/** Number input row (the hub used seekbars; same values, same bounds). */
function numberRow(opts: {
  label: string;
  description: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  extra?: (config: GestureConfig) => boolean;
}): Element {
  const row = doc.createXULElement("vbox");
  const line = doc.createXULElement("hbox");
  line.setAttribute("align", "center");
  const lab = doc.createXULElement("label");
  lab.textContent = opts.label;
  lab.setAttribute("flex", "1");
  const input = doc.createElement("input");
  input.type = "number";
  input.min = String(opts.min);
  input.max = String(opts.max);
  if (opts.step !== undefined) input.step = String(opts.step);
  input.value = String(opts.value);
  input.style.width = "6em";
  let lastValid = opts.value;
  input.addEventListener("change", () => {
    const n = Math.round(Number(input.value));
    if (!Number.isFinite(n)) {
      input.value = String(lastValid);
      return;
    }
    const v = Math.min(opts.max, Math.max(opts.min, n));
    input.value = String(v);
    lastValid = v;
    opts.onChange(v);
  });
  line.append(lab, input);
  row.appendChild(line);
  row.appendChild(deemphasized(opts.description));
  gated.push({ el: input, extra: opts.extra });
  return row;
}

/** Bare action dropdown for the mappings table. An action id saved in the
 * pref but missing from the hub list still gets an item so it displays. */
function actionMenulist(
  current: string,
  onChange: (value: string) => void,
): Element {
  const list = doc.createXULElement("menulist");
  list.setAttribute("flex", "1");
  const popup = doc.createXULElement("menupopup");
  const options = !current || ACTIONS.some((a) => a.id === current)
    ? ACTIONS
    : [...ACTIONS, { id: current, label: current }];
  for (const opt of options) {
    const mi = doc.createXULElement("menuitem");
    mi.setAttribute("label", opt.label);
    mi.setAttribute("value", opt.id);
    popup.appendChild(mi);
  }
  list.appendChild(popup);
  try {
    (list as unknown as { value: string }).value = current;
  } catch { /* leave default */ }
  list.addEventListener("command", () => {
    onChange((list as unknown as { value: string }).value);
  });
  return list;
}

function patternText(pattern: GestureDirection[]): string {
  return pattern
    .map((d) => (ARROWS as Record<string, string>)[d] ?? "?")
    .join("");
}

function isPatternDuplicate(pattern: GestureDirection[]): boolean {
  return readConfig().actions.some((a) =>
    Array.isArray(a.pattern) &&
    a.pattern.length === pattern.length &&
    a.pattern.every((d, i) => d === pattern[i])
  );
}

/* ------------------------------------------------------------------ */
/* Pane content                                                        */
/* ------------------------------------------------------------------ */

function buildGeneralGroup(): Element {
  const enableRow = checkboxRow({
    id: "derp-gesture-enabled",
    label: "Enable mouse gestures",
    description: "Allows you to control your browser with mouse movements",
    preference: ENABLED_PREF,
  });
  // Re-evaluate gating after the native binding writes the pref (the
  // microtask runs after every command listener in this dispatch).
  enableRow.firstElementChild?.addEventListener("command", () => {
    void Promise.resolve().then(refreshDisabled);
  });

  const rockerRow = checkboxRow({
    id: "derp-gesture-rocker",
    label: "Enable rocker gestures",
    description:
      "Right-click and move left to go back, right-click and move right to go forward. (Experimental)",
    checked: () => readConfig().rockerGesturesEnabled,
    onChange: (checked) => {
      writeConfig((config) => {
        config.rockerGesturesEnabled = checked;
      });
      refreshDisabled();
    },
  });
  const rockerCheckbox = rockerRow.firstElementChild;
  if (rockerCheckbox) gated.push({ el: rockerCheckbox });

  const menuOptions = ACTIONS.map((a) => ({ label: a.label, value: a.id }));
  const leftRightRow = menulistRow(
    "derp-gesture-rocker-leftright",
    "Left → Right",
    menuOptions,
    () => readConfig().rockerActions.leftRight,
    (value) =>
      writeConfig((config) => {
        config.rockerActions = { ...config.rockerActions, leftRight: value };
      }),
    "Hold left button, then click right button",
  );
  const rightLeftRow = menulistRow(
    "derp-gesture-rocker-rightleft",
    "Right → Left",
    menuOptions,
    () => readConfig().rockerActions.rightLeft,
    (value) =>
      writeConfig((config) => {
        config.rockerActions = { ...config.rockerActions, rightLeft: value };
      }),
    "Hold right button, then click left button",
  );
  for (const row of [leftRightRow, rightLeftRow]) {
    const list = row.querySelector("menulist");
    if (list) {
      gated.push({ el: list, extra: (c) => c.rockerGesturesEnabled });
    }
  }

  const wheelRow = checkboxRow({
    id: "derp-gesture-wheel",
    label: "Enable wheel gestures",
    checked: () => readConfig().wheelGesturesEnabled,
    onChange: (checked) =>
      writeConfig((config) => {
        config.wheelGesturesEnabled = checked;
      }),
  });
  const wheelCheckbox = wheelRow.firstElementChild;
  if (wheelCheckbox) gated.push({ el: wheelCheckbox });

  return groupboxOf("General Settings", [
    deemphasized("Basic mouse gesture settings"),
    enableRow,
    rockerRow,
    leftRightRow,
    rightLeftRow,
    wheelRow,
  ]);
}

function buildSensitivityGroup(): Element {
  const config = readConfig();
  return groupboxOf("Sensitivity Settings", [
    deemphasized("Adjust gesture recognition sensitivity."),
    numberRow({
      label: "Sensitivity",
      description: "Adjust gesture recognition sensitivity (1–100)",
      min: 1,
      max: 100,
      value: config.sensitivity,
      onChange: (v) =>
        writeConfig((c) => {
          c.sensitivity = v;
        }),
    }),
    numberRow({
      label: "Minimum distance (px)",
      description: "Minimum movement distance to be recognized as a gesture",
      min: 5,
      max: 50,
      value: config.contextMenu.minDistance,
      onChange: (v) =>
        writeConfig((c) => {
          c.contextMenu = { ...c.contextMenu, minDistance: v };
        }),
    }),
    numberRow({
      label: "Right-click suppression time (ms)",
      description: "Time to suppress right-click menu after gesture",
      min: 0,
      max: 1000,
      step: 50,
      value: config.contextMenu.preventionTimeout,
      onChange: (v) =>
        writeConfig((c) => {
          c.contextMenu = { ...c.contextMenu, preventionTimeout: v };
        }),
    }),
  ]);
}

function buildTrailGroup(): Element {
  const config = readConfig();

  const showTrailRow = checkboxRow({
    id: "derp-gesture-show-trail",
    label: "Show gesture trail",
    description: "Draw a line following your mouse movements",
    checked: () => readConfig().showTrail,
    onChange: (checked) => {
      writeConfig((c) => {
        c.showTrail = checked;
      });
      refreshDisabled();
    },
  });
  const showTrailCheckbox = showTrailRow.firstElementChild;
  if (showTrailCheckbox) gated.push({ el: showTrailCheckbox });

  const showLabelRow = checkboxRow({
    id: "derp-gesture-show-label",
    label: "Show gesture label",
    description: "Display the action name during gesture",
    checked: () => readConfig().showLabel,
    onChange: (checked) =>
      writeConfig((c) => {
        c.showLabel = checked;
      }),
  });
  const showLabelCheckbox = showLabelRow.firstElementChild;
  if (showLabelCheckbox) gated.push({ el: showLabelCheckbox });

  // Trail color: color picker + hex text field, kept in sync. The hub wrote
  // every keystroke; here only valid #rrggbb values are committed.
  const colorRow = doc.createXULElement("hbox");
  colorRow.setAttribute("align", "center");
  const colorLabel = doc.createXULElement("label");
  colorLabel.textContent = "Trail color";
  colorLabel.setAttribute("flex", "1");
  const colorInput = doc.createElement("input");
  colorInput.type = "color";
  colorInput.value = config.trailColor;
  const colorText = doc.createElement("input");
  colorText.type = "text";
  colorText.value = config.trailColor;
  colorText.placeholder = "#000000";
  colorText.style.width = "6em";
  colorText.style.marginInlineStart = "8px";
  colorInput.addEventListener("change", () => {
    writeConfig((c) => {
      c.trailColor = colorInput.value;
    });
    colorText.value = colorInput.value;
  });
  colorText.addEventListener("change", () => {
    const v = colorText.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      writeConfig((c) => {
        c.trailColor = v;
      });
      colorInput.value = v;
    } else {
      colorText.value = readConfig().trailColor;
    }
  });
  colorRow.append(colorLabel, colorInput, colorText);
  gated.push({ el: colorInput, extra: (c) => c.showTrail });
  gated.push({ el: colorText, extra: (c) => c.showTrail });

  return groupboxOf("Trail Settings", [
    deemphasized("Customize the appearance of gesture trails."),
    showTrailRow,
    showLabelRow,
    numberRow({
      label: "Trail width (px)",
      description: "Width of the gesture trail line",
      min: 1,
      max: 10,
      value: config.trailWidth,
      onChange: (v) =>
        writeConfig((c) => {
          c.trailWidth = v;
        }),
      extra: (c) => c.showTrail,
    }),
    colorRow,
  ]);
}

function buildActionsGroup(): Element {
  const header = doc.createXULElement("hbox");
  header.setAttribute("align", "center");
  const patternHead = doc.createElement("span");
  patternHead.textContent = "Pattern";
  patternHead.style.minWidth = "7em";
  patternHead.style.fontWeight = "600";
  const actionHead = doc.createXULElement("label");
  actionHead.textContent = "Action";
  actionHead.setAttribute("flex", "1");
  (actionHead as unknown as { style: CSSStyleDeclaration }).style.fontWeight =
    "600";
  header.append(patternHead, actionHead);

  const rowsBox = doc.createXULElement("vbox");

  const renderRows = (): void => {
    const config = readConfig();
    const children: Element[] = [];
    config.actions.forEach((mapping, index) => {
      const row = doc.createXULElement("hbox");
      row.setAttribute("align", "center");
      (row as unknown as { style: CSSStyleDeclaration }).style.marginBlock =
        "2px";

      const pattern = doc.createElement("span");
      pattern.textContent = patternText(
        Array.isArray(mapping.pattern) ? mapping.pattern : [],
      );
      pattern.title = Array.isArray(mapping.pattern)
        ? mapping.pattern.join("-")
        : "";
      pattern.style.minWidth = "7em";
      pattern.style.fontSize = "1.1em";
      pattern.style.letterSpacing = "2px";

      const list = actionMenulist(mapping.action, (value) => {
        writeConfig((c) => {
          if (c.actions[index]) {
            c.actions[index] = { ...c.actions[index], action: value };
          }
        });
      });

      const del = doc.createXULElement("button");
      del.setAttribute("label", "Delete");
      del.addEventListener("command", () => {
        writeConfig((c) => {
          c.actions.splice(index, 1);
        });
        renderRows();
      });

      row.append(pattern, list, del);
      children.push(row);
    });
    if (children.length === 0) {
      children.push(deemphasized("No gestures configured"));
    }
    rowsBox.replaceChildren(...children);
  };
  renderRows();

  // --- "Add gesture" row ---
  const addRow = doc.createXULElement("hbox");
  addRow.setAttribute("align", "center");
  (addRow as unknown as { style: CSSStyleDeclaration }).style.marginBlockStart =
    "8px";
  const patternInput = doc.createElement("input");
  patternInput.type = "text";
  patternInput.placeholder = "e.g. up-down-left";
  patternInput.style.width = "12em";
  patternInput.style.marginInlineEnd = "8px";
  // The hub's "new gesture" default was the first list entry (gecko-back).
  const addList = actionMenulist("gecko-back", () => {});
  const addButton = doc.createXULElement("button");
  addButton.setAttribute("label", "Add Gesture");

  const addError = deemphasized("");
  addError.style.color = "var(--text-color-error, #c50042)";
  addError.hidden = true;
  const showAddError = (message: string): void => {
    addError.textContent = message;
    addError.hidden = false;
  };

  const addGesture = (): void => {
    addError.hidden = true;
    const text = patternInput.value.trim();
    if (!text) {
      showAddError("Please set a gesture pattern");
      return;
    }
    const pattern: GestureDirection[] = [];
    for (const token of text.split("-").map((t) => t.trim()).filter(Boolean)) {
      const dir = DIRECTIONS.find(
        (d) => d.toLowerCase() === token.toLowerCase(),
      );
      if (!dir) {
        showAddError(
          `Unknown direction "${token}" — use up, down, left, right, ` +
            "upLeft, upRight, downLeft, downRight",
        );
        return;
      }
      if (pattern[pattern.length - 1] === dir) {
        showAddError(
          "The same direction cannot repeat back-to-back " +
            "(the recognizer never produces that)",
        );
        return;
      }
      pattern.push(dir);
    }
    if (pattern.length === 0) {
      showAddError("Please set a gesture pattern");
      return;
    }
    if (isPatternDuplicate(pattern)) {
      showAddError("This gesture pattern already exists");
      return;
    }
    const action = (addList as unknown as { value: string }).value;
    writeConfig((c) => {
      c.actions = [...c.actions, { pattern, action }];
    });
    patternInput.value = "";
    renderRows();
  };
  addButton.addEventListener("command", addGesture);
  patternInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addGesture();
    }
  });
  addRow.append(patternInput, addList, addButton);
  gated.push({ el: patternInput });
  gated.push({ el: addList });
  gated.push({ el: addButton });

  return groupboxOf("Gesture Actions", [
    deemphasized(
      "Configure mouse gesture actions. Patterns are hyphen-separated " +
        "directions: up, down, left, right, upLeft, upRight, downLeft, " +
        "downRight.",
    ),
    header,
    rowsBox,
    addRow,
    addError,
  ]);
}

function build(root: Element): void {
  root.appendChild(paneHeader(
    "Mouse Gestures",
    "Control your browser with mouse movements.",
  ));
  root.appendChild(buildGeneralGroup());
  root.appendChild(buildSensitivityGroup());
  root.appendChild(buildTrailGroup());
  root.appendChild(buildActionsGroup());
  refreshDisabled();
}

function init(): void {
  ensureBoolPref(ENABLED_PREF);
  queuePrefsUpdate();
  refreshDisabled();
}

const ICON = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="context-fill" fill-opacity="context-fill-opacity"><path fill-rule="evenodd" d="M8 1C5.24 1 3 3.24 3 6v4c0 2.76 2.24 5 5 5s5-2.24 5-5V6c0-2.76-2.24-5-5-5zm0 1.25A3.75 3.75 0 0 1 11.75 6v4a3.75 3.75 0 0 1-7.5 0V6A3.75 3.75 0 0 1 8 2.25zM8 4.1a.7.7 0 0 0-.7.7v2.4a.7.7 0 0 0 1.4 0V4.8a.7.7 0 0 0-.7-.7z"/></svg>`,
);

export function registerGesturePane(): void {
  const ok = addDerpPane({
    category: "paneDerpGestures",
    categoryId: "category-derp-gestures",
    label: "Mouse Gestures",
    icon: ICON,
    build,
    init,
  });
  log("gestures pane:", ok ? "registered" : "FAILED");
}
