/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Keyboard Shortcuts pane — port of the hub's keyboard-shortcut settings
 * page (pages-settings/src/app/keyboard-shortcut): the enable switch lives
 * in the floorp.keyboardshortcut.enabled bool pref; the bindings live in
 * the floorp.keyboardshortcut.config JSON pref as
 * `{ shortcuts: { [actionId]: { key, modifiers: {alt,ctrl,meta,shift},
 * action } } }`. Writes reproduce the hub dataManager's semantics:
 * read-modify-write of the shortcuts record, `enabled` never written into
 * the JSON blob, keys stored as KeyboardEvent.code with the Key/Digit
 * prefix stripped (KeyA → "A", Digit5 → "5", ArrowUp stays "ArrowUp") —
 * the exact domain the consuming feature's config.ts parses.
 *
 * One row per action from the hub's list (shared with mouse gestures),
 * plus rows for any extra action ids already present in the saved config
 * (e.g. bork's own chrome chords, which the feature registers dynamically).
 * "Set" enters record mode: a capturing keydown listener on the pane
 * document records modifiers+key, Escape (or clicking elsewhere) cancels,
 * and a combo already assigned to another action is refused with an inline
 * warning — the same conflict rule the hub's editor enforced.
 */

import {
  addBorkPane,
  checkboxRow,
  doc,
  ensureBoolPref,
  groupboxOf,
  log,
  paneHeader,
  queuePrefsUpdate,
  readJsonPref,
} from "./framework.ts";

const ENABLED_PREF = "floorp.keyboardshortcut.enabled";
const CONFIG_PREF = "floorp.keyboardshortcut.config";

/* ------------------------------------------------------------------ */
/* Config model (mirrors the hub dataManager's shape and defaults)     */
/* ------------------------------------------------------------------ */

interface Modifiers {
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

interface ShortcutConfig {
  modifiers: Modifiers;
  key: string;
  action: string;
}

/** The hub's default when the config pref is empty: F2 toggles the
 * command palette. (In practice the feature has usually written its full
 * defaults to the pref before this pane is ever opened.) */
const HUB_DEFAULT_SHORTCUTS: Record<string, ShortcutConfig> = {
  "floorp-toggle-command-palette": {
    key: "F2",
    modifiers: { alt: false, ctrl: false, meta: false, shift: false },
    action: "floorp-toggle-command-palette",
  },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isValidShortcut(v: unknown): v is ShortcutConfig {
  if (!isRecord(v)) return false;
  if (typeof v.key !== "string" || v.key.length === 0) return false;
  const m = v.modifiers;
  return isRecord(m) &&
    typeof m.alt === "boolean" &&
    typeof m.ctrl === "boolean" &&
    typeof m.meta === "boolean" &&
    typeof m.shift === "boolean";
}

function readShortcuts(): Record<string, ShortcutConfig> {
  const raw = readJsonPref(CONFIG_PREF);
  if (isRecord(raw.shortcuts)) {
    return { ...(raw.shortcuts as unknown as Record<string, ShortcutConfig>) };
  }
  return { ...HUB_DEFAULT_SHORTCUTS };
}

/** Read-modify-write of the same JSON pref the hub's dataManager wrote:
 * unknown top-level fields survive, `enabled` is stripped — the hub kept
 * it only in the bool pref. */
function writeShortcuts(shortcuts: Record<string, ShortcutConfig>): void {
  const out: Record<string, unknown> = { ...readJsonPref(CONFIG_PREF) };
  out.shortcuts = shortcuts;
  delete out.enabled;
  Services.prefs.setStringPref(CONFIG_PREF, JSON.stringify(out));
}

function saveShortcut(shortcut: ShortcutConfig): void {
  const shortcuts = readShortcuts();
  shortcuts[shortcut.action] = shortcut;
  writeShortcuts(shortcuts);
}

function clearShortcut(actionId: string): void {
  const shortcuts = readShortcuts();
  delete shortcuts[actionId];
  writeShortcuts(shortcuts);
}

/** Same conflict rule as the hub's editor: exact key + all four modifier
 * booleans, compared against every other action's binding. */
function findConflict(shortcut: ShortcutConfig): string | null {
  for (const [id, other] of Object.entries(readShortcuts())) {
    if (id === shortcut.action || !isValidShortcut(other)) continue;
    if (
      other.key === shortcut.key &&
      other.modifiers.alt === shortcut.modifiers.alt &&
      other.modifiers.ctrl === shortcut.modifiers.ctrl &&
      other.modifiers.meta === shortcut.modifiers.meta &&
      other.modifiers.shift === shortcut.modifiers.shift
    ) {
      return id;
    }
  }
  return null;
}

function comboKey(s: ShortcutConfig): string {
  const m = s.modifiers;
  return `${m.alt ? 1 : 0}|${m.ctrl ? 1 : 0}|${m.meta ? 1 : 0}|${
    m.shift ? 1 : 0
  }|${s.key}`;
}

/* ------------------------------------------------------------------ */
/* Combo display (mac symbols vs. names, hub's modifier order)         */
/* ------------------------------------------------------------------ */

const IS_MAC = Services.appinfo.OS === "Darwin";

function modifierSymbol(modifier: keyof Modifiers): string {
  if (IS_MAC) {
    return { alt: "⌥", ctrl: "⌃", meta: "⌘", shift: "⇧" }[modifier];
  }
  return { alt: "Alt", ctrl: "Ctrl", meta: "Meta", shift: "Shift" }[modifier];
}

function displayKey(key: string): string {
  return key.replace(/^Arrow/, "").toUpperCase();
}

function formatCombo(shortcut: ShortcutConfig): string {
  const parts: string[] = [];
  if (shortcut.modifiers.alt) parts.push(modifierSymbol("alt"));
  if (shortcut.modifiers.ctrl) parts.push(modifierSymbol("ctrl"));
  if (shortcut.modifiers.meta) parts.push(modifierSymbol("meta"));
  if (shortcut.modifiers.shift) parts.push(modifierSymbol("shift"));
  parts.push(displayKey(shortcut.key));
  return parts.join(IS_MAC ? "" : "+");
}

/* ------------------------------------------------------------------ */
/* Action list (mirrors the hub's GESTURE_ACTIONS + en-US labels — the  */
/* hub's shortcuts table iterates exactly this list)                    */
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
  { id: "floorp-open-hub", label: "Open Bork Hub" },
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

/** bork registers these into the action registry at runtime; the hub's
 * list never knew them, but their saved bindings deserve visible rows. */
const EXTRA_ACTION_LABELS: Record<string, string> = {
  "bork-toggle-urlbar": "Toggle Address Bar",
  "bork-toggle-panel-sidebar": "Toggle Panel Sidebar",
};

function humanize(id: string): string {
  return id
    .replace(/^(gecko|floorp|bork)-/, "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** The hub's 93 actions, plus any action ids present in the saved config
 * that the list does not know (bork's dynamic registrations). */
function allActions(): ActionOption[] {
  const known = new Set(ACTIONS.map((a) => a.id));
  const extras = Object.keys(readShortcuts())
    .filter((id) => !known.has(id))
    .map((id) => ({ id, label: EXTRA_ACTION_LABELS[id] ?? humanize(id) }));
  return [...ACTIONS, ...extras];
}

/* ------------------------------------------------------------------ */
/* Rows + record mode                                                  */
/* ------------------------------------------------------------------ */

interface ShortcutRow {
  actionId: string;
  combo: HTMLSpanElement;
  setButton: Element;
  clearButton: Element;
  warn: HTMLParagraphElement;
}

const rows: ShortcutRow[] = [];
let labelById: Map<string, string> = new Map();
let recording: { actionId: string; cancel: () => void } | null = null;

function labelOf(actionId: string): string {
  return labelById.get(actionId) ?? actionId;
}

function setButtonLabel(button: Element, label: string): void {
  button.setAttribute("label", label);
}

function setDisabled(el: Element, disabled: boolean): void {
  if (disabled) el.setAttribute("disabled", "true");
  else el.removeAttribute("disabled");
}

function refreshAllRows(): void {
  const shortcuts = readShortcuts();
  const byCombo = new Map<string, string[]>();
  for (const [id, s] of Object.entries(shortcuts)) {
    if (!isValidShortcut(s)) continue;
    const key = comboKey(s);
    const group = byCombo.get(key) ?? [];
    group.push(id);
    byCombo.set(key, group);
  }
  for (const row of rows) {
    if (recording?.actionId === row.actionId) continue; // keep record UI
    const raw: unknown = shortcuts[row.actionId];
    const shortcut = isValidShortcut(raw) ? raw : null;
    row.combo.textContent = shortcut ? formatCombo(shortcut) : "Not set";
    row.combo.style.opacity = shortcut ? "" : "0.6";
    setButtonLabel(row.setButton, "Set");
    setDisabled(row.clearButton, shortcut === null);
    let conflict: string | null = null;
    if (shortcut) {
      const other = (byCombo.get(comboKey(shortcut)) ?? [])
        .find((id) => id !== row.actionId);
      if (other !== undefined) {
        conflict = `This shortcut is already in use — also assigned to "${
          labelOf(other)
        }"`;
      }
    }
    row.warn.hidden = conflict === null;
    row.warn.textContent = conflict ?? "";
  }
}

function commitRecording(row: ShortcutRow, shortcut: ShortcutConfig): void {
  const conflictId = findConflict(shortcut);
  if (conflictId) {
    // Refused, like the hub's disabled Save on conflict: nothing is written.
    refreshAllRows();
    row.warn.textContent = `This shortcut is already in use — assigned to "${
      labelOf(conflictId)
    }"`;
    row.warn.hidden = false;
    return;
  }
  saveShortcut(shortcut);
  refreshAllRows();
}

function startRecording(row: ShortcutRow): void {
  recording?.cancel(); // a second Set click never stacks listeners

  const onKeyDown = (e: KeyboardEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === "Escape") {
      cancel();
      return;
    }
    // A lone modifier keeps record mode open, same as the hub's editor.
    if (/^(Alt|Control|Meta|Shift)/.test(e.code)) return;
    const shortcut: ShortcutConfig = {
      key: e.code.replace(/^(Key|Digit)/, ""),
      modifiers: {
        alt: e.altKey,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        shift: e.shiftKey,
      },
      action: row.actionId,
    };
    teardown();
    commitRecording(row, shortcut);
  };
  const onMouseDown = (e: MouseEvent): void => {
    // The row's own Set button toggles via its command handler.
    if (e.target instanceof Node && row.setButton.contains(e.target)) return;
    cancel();
  };
  const teardown = (): void => {
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("mousedown", onMouseDown, true);
    recording = null;
  };
  const cancel = (): void => {
    teardown();
    refreshAllRows();
  };

  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("mousedown", onMouseDown, true);
  recording = { actionId: row.actionId, cancel };

  row.combo.textContent = "Press any key...";
  row.combo.style.opacity = "";
  setButtonLabel(row.setButton, "Cancel");
  row.warn.hidden = true;
}

function buildRow(action: ActionOption): Element {
  const wrap = doc.createXULElement("vbox");
  const line = doc.createXULElement("hbox");
  line.setAttribute("align", "center");

  const name = doc.createXULElement("label");
  name.setAttribute("flex", "1");
  name.textContent = action.label;
  name.setAttribute("tooltiptext", action.id);

  const combo = doc.createElement("span");
  combo.style.minWidth = "11em";
  combo.style.fontFamily = "monospace";

  const setButton = doc.createXULElement("button");
  setButton.setAttribute("label", "Set");
  const clearButton = doc.createXULElement("button");
  clearButton.setAttribute("label", "Clear");

  const warn = doc.createElement("p");
  warn.className = "description-deemphasized";
  warn.style.color = "var(--text-color-error, #c50042)";
  warn.style.marginBlock = "0";
  warn.hidden = true;

  const row: ShortcutRow = {
    actionId: action.id,
    combo,
    setButton,
    clearButton,
    warn,
  };
  setButton.addEventListener("command", () => {
    const active = recording;
    if (active && active.actionId === row.actionId) active.cancel();
    else startRecording(row);
  });
  clearButton.addEventListener("command", () => {
    recording?.cancel();
    clearShortcut(row.actionId);
    refreshAllRows();
  });

  line.append(name, combo, setButton, clearButton);
  wrap.append(line, warn);
  rows.push(row);
  return wrap;
}

/* ------------------------------------------------------------------ */
/* Pane content                                                        */
/* ------------------------------------------------------------------ */

function deemphasized(text: string): HTMLParagraphElement {
  const p = doc.createElement("p");
  p.className = "description-deemphasized";
  p.style.marginBlock = "0";
  p.textContent = text;
  return p;
}

function build(root: Element): void {
  root.appendChild(paneHeader(
    "Keyboard Shortcuts",
    "Customize keyboard shortcuts for various browser actions.",
  ));

  root.appendChild(groupboxOf("Basic Settings", [
    deemphasized("Configure basic keyboard shortcut settings"),
    checkboxRow({
      id: "bork-shortcuts-enabled",
      label: "Enable custom keyboard shortcuts",
      description:
        "When enabled, you can customize keyboard shortcuts for various " +
        "browser actions. When disabled, default Firefox shortcuts will " +
        "be used. A restart is required to completely enable or disable " +
        "the custom keyboard shortcuts feature.",
      preference: ENABLED_PREF,
    }),
  ]));

  const actions = allActions();
  labelById = new Map(actions.map((a) => [a.id, a.label]));

  const header = doc.createXULElement("hbox");
  header.setAttribute("align", "center");
  const actionHead = doc.createXULElement("label");
  actionHead.textContent = "Action";
  actionHead.setAttribute("flex", "1");
  (actionHead as unknown as { style: CSSStyleDeclaration }).style.fontWeight =
    "600";
  const comboHead = doc.createElement("span");
  comboHead.textContent = "Shortcut";
  comboHead.style.minWidth = "11em";
  comboHead.style.fontWeight = "600";
  header.append(actionHead, comboHead);

  const list = doc.createXULElement("vbox");
  for (const action of actions) list.appendChild(buildRow(action));

  root.appendChild(groupboxOf("Shortcuts", [
    deemphasized(
      "Configure keyboard shortcuts for various browser actions. Some " +
        "shortcuts may conflict with Firefox's default shortcuts.",
    ),
    header,
    list,
  ]));

  refreshAllRows();
}

function init(): void {
  // The consuming feature reads this pref with a default of true; seed the
  // pref when it does not exist at all so the checkbox binding shows the
  // effective value (writing the default changes nothing semantically).
  if (Services.prefs.getPrefType(ENABLED_PREF) === Services.prefs.PREF_INVALID) {
    Services.prefs.setBoolPref(ENABLED_PREF, true);
  }
  ensureBoolPref(ENABLED_PREF);
  queuePrefsUpdate();
}

const ICON = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="context-fill" fill-opacity="context-fill-opacity"><path fill-rule="evenodd" d="M2.5 3.5h11A1.5 1.5 0 0 1 15 5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 11V5a1.5 1.5 0 0 1 1.5-1.5zm0 1.25a.25.25 0 0 0-.25.25v6c0 .14.11.25.25.25h11a.25.25 0 0 0 .25-.25V5a.25.25 0 0 0-.25-.25h-11zM3.25 5.75h1.25V7H3.25zm2.55 0h1.25V7H5.8zm2.55 0h1.25V7H8.35zm2.55 0h1.25V7H10.9zM3.25 8.75h1.25V10H3.25zm2 0h5.5V10h-5.5zm7 0h1.25V10h-1.25z"/></svg>`,
);

export function registerShortcutsPane(): void {
  const ok = addBorkPane({
    category: "paneBorkShortcuts",
    categoryId: "category-bork-shortcuts",
    label: "Keyboard Shortcuts",
    icon: ICON,
    build,
    init,
  });
  log("shortcuts pane:", ok ? "registered" : "FAILED");
}
