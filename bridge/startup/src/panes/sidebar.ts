/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Panel Sidebar pane — port of the hub's sidebar settings page
 * (pages-settings/src/app/sidebar): the floorp.panelSidebar.enabled bool
 * pref, the settings kept in the floorp.panelSidebar.config JSON pref, and
 * a read-only view of the saved panels (floorp.panelSidebar.data) with
 * per-panel delete. Full panel management (add/edit/reorder) stays in the
 * sidebar itself.
 *
 * Text mirrors the hub's en-US strings; i18n wiring is a follow-up for all
 * derp panes at once.
 */

import {
  addDerpPane,
  checkboxRow,
  doc,
  ensureBoolPref,
  groupboxOf,
  log,
  paneHeader,
  queuePrefsUpdate,
  radioGroup,
  readJsonPref,
  win,
  writeJsonPrefField,
} from "./framework.ts";

const ENABLED_PREF = "floorp.panelSidebar.enabled";
const CONFIG_PREF = "floorp.panelSidebar.config";
const DATA_PREF = "floorp.panelSidebar.data";

/* ------------------------------------------------------------------ */
/* floorp.panelSidebar.config — flat JSON fields                       */
/* ------------------------------------------------------------------ */

function configBool(field: string, fallback: boolean): boolean {
  const v = readJsonPref(CONFIG_PREF)[field];
  return typeof v === "boolean" ? v : fallback;
}

function configNumber(field: string): number | null {
  const v = readJsonPref(CONFIG_PREF)[field];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/* ------------------------------------------------------------------ */
/* floorp.panelSidebar.data — {data: Panel[]}                          */
/* ------------------------------------------------------------------ */

interface PanelEntry extends Record<string, unknown> {
  id?: unknown;
  type?: unknown;
  width?: unknown;
  url?: unknown;
  icon?: unknown;
  extensionId?: unknown;
}

function readPanels(): PanelEntry[] {
  // Mirror of the hub's getPanelsList: parse the pref, return data.data.
  try {
    const raw = Services.prefs.getStringPref(DATA_PREF, "");
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const data = (parsed as { data?: unknown }).data;
    return Array.isArray(data) ? data as PanelEntry[] : [];
  } catch (e) {
    console.error("[derp-panes] failed to parse panel sidebar data:", e);
    return [];
  }
}

function deletePanelById(panelId: string): void {
  // Mirror of the hub's deletePanel: filter by id, write back {data: [...]}
  // — the exact shape its savePanelsList serialized. The entries round-trip
  // untouched, so fields this pane does not know about are preserved.
  const remaining = readPanels().filter((p) => p.id !== panelId);
  Services.prefs.setStringPref(DATA_PREF, JSON.stringify({ data: remaining }));
}

const STATIC_PANEL_NAMES: Record<string, string> = {
  bmt: "Browser Manager Tool",
  bookmarks: "Bookmarks",
  history: "History",
  downloads: "Downloads",
  notes: "Notes",
};

const PANEL_TYPE_NAMES: Record<string, string> = {
  web: "Web",
  static: "Sidebar Tool",
  extension: "Extension",
};

function panelDisplayName(panel: PanelEntry): string {
  const url = typeof panel.url === "string" ? panel.url : "";
  if (panel.type === "static") {
    // Static panel urls look like "floorp//bookmarks".
    if (!url) return "Untitled";
    const key = url.replace("floorp//", "");
    return STATIC_PANEL_NAMES[key] ?? url;
  }
  const extensionId = typeof panel.extensionId === "string"
    ? panel.extensionId
    : "";
  return url || extensionId || "Untitled";
}

function panelTypeName(panel: PanelEntry): string {
  return typeof panel.type === "string"
    ? PANEL_TYPE_NAMES[panel.type] ?? panel.type
    : "";
}

function confirmDelete(): boolean {
  try {
    const prompt = (Services as unknown as {
      prompt: {
        confirm: (
          parent: Window | null,
          title: string,
          text: string,
        ) => boolean;
      };
    }).prompt;
    return prompt.confirm(
      win as unknown as Window,
      "Delete Panel",
      "Are you sure you want to delete this panel?",
    );
  } catch {
    return true; // prompt service unavailable — proceed
  }
}

function renderPanels(listBox: Element): void {
  while (listBox.firstChild) listBox.firstChild.remove();
  const panels = readPanels();

  if (panels.length === 0) {
    const empty = doc.createElement("p");
    empty.className = "description-deemphasized";
    empty.style.marginBlock = "0";
    empty.textContent = "No panels configured.";
    listBox.appendChild(empty);
    return;
  }

  for (const panel of panels) {
    const row = doc.createXULElement("hbox");
    row.setAttribute("align", "center");
    row.setAttribute("style", "padding: 4px 0;");

    if (typeof panel.icon === "string" && panel.icon) {
      const img = doc.createXULElement("image");
      img.setAttribute("src", panel.icon);
      img.setAttribute(
        "style",
        "width: 16px; height: 16px; margin-inline-end: 8px;",
      );
      row.appendChild(img);
    }

    const info = doc.createXULElement("vbox");
    info.setAttribute("flex", "1");
    const name = doc.createXULElement("label");
    name.setAttribute("crop", "end");
    name.textContent = panelDisplayName(panel);
    const meta = doc.createElement("p");
    meta.className = "description-deemphasized";
    meta.style.marginBlock = "0";
    meta.textContent = typeof panel.width === "number" && panel.width > 0
      ? `${panelTypeName(panel)} · ${panel.width}px`
      : panelTypeName(panel);
    info.append(name, meta);
    row.appendChild(info);

    if (typeof panel.id === "string") {
      const id = panel.id;
      const del = doc.createXULElement("button");
      del.setAttribute("label", "Delete");
      del.addEventListener("command", () => {
        if (!confirmDelete()) return;
        deletePanelById(id);
        renderPanels(listBox);
      });
      row.appendChild(del);
    }

    listBox.appendChild(row);
  }
}

/* ------------------------------------------------------------------ */
/* Local control builders                                              */
/* ------------------------------------------------------------------ */

function noteText(text: string): Element {
  const p = doc.createElement("p");
  p.className = "description-deemphasized";
  p.style.marginBlock = "0";
  p.textContent = text;
  return p;
}

function sectionHeader(title: string): Element {
  const label = doc.createXULElement("label");
  label.setAttribute("style", "font-weight: 600; margin-block-start: 8px;");
  label.textContent = title;
  return label;
}

function labelLine(text: string): Element {
  const label = doc.createXULElement("label");
  label.textContent = text;
  return label;
}

interface NumberRowSpec {
  id: string;
  label: string;
  current: () => number | null;
  onChange: (value: number) => void;
  description?: string;
}

/** Labeled html input[type=number]; commits on change (blur/Enter). An
 * emptied field keeps the last saved value instead of writing 0. */
function numberRow(spec: NumberRowSpec): Element {
  const row = doc.createXULElement("vbox");
  const line = doc.createXULElement("hbox");
  line.setAttribute("align", "center");
  const lab = doc.createXULElement("label");
  lab.setAttribute("flex", "1");
  lab.textContent = spec.label;
  line.appendChild(lab);
  const input = doc.createElement("input");
  input.type = "number";
  input.id = spec.id;
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

/* ------------------------------------------------------------------ */
/* Pane                                                                */
/* ------------------------------------------------------------------ */

function build(root: Element): void {
  root.appendChild(paneHeader(
    "Panel Sidebar",
    "Panel Sidebar is a feature that allows you to display various tools, websites, and extensions on the side of the window. Here, you can customize, add, delete, and manage panels.",
  ));

  root.appendChild(groupboxOf("Basic Settings", [
    checkboxRow({
      id: "derp-sidebar-enabled",
      label: "Enable Panel Sidebar",
      description:
        "Panel Sidebar is different from Firefox's sidebar and won't interfere with it. Panel Sidebar can display web pages, unlike Firefox's sidebar. You can also manage workspaces in the sidebar. Derp's restart is required to completely enable or disable the panel sidebar feature.",
      preference: ENABLED_PREF,
    }),
    sectionHeader("Other Panel Sidebar Settings"),
    checkboxRow({
      id: "derp-sidebar-auto-unload",
      label: "Unload when closing panel",
      checked: () => configBool("autoUnload", false),
      onChange: (checked) =>
        writeJsonPrefField(CONFIG_PREF, "autoUnload", checked),
    }),
    numberRow({
      id: "derp-sidebar-global-width",
      label: "Global Web Panel Width",
      current: () => configNumber("globalWidth"),
      onChange: (value) =>
        writeJsonPrefField(CONFIG_PREF, "globalWidth", value),
      description: "Global width is applied when panel width is set to 0.",
    }),
    noteText(
      "The icon provider setting has been removed as Derp now tries to get panel icons directly from web pages when possible.",
    ),
  ]));

  const listBox = doc.createXULElement("vbox");
  listBox.id = "derp-sidebar-panel-list";
  renderPanels(listBox);
  root.appendChild(groupboxOf("Panel List", [
    noteText(
      "Panels are added, edited and reordered from the sidebar itself; saved panels can be removed here.",
    ),
    listBox,
  ]));

  // Keep the list truthful while the page is open — panels are usually
  // added and removed from the sidebar.
  try {
    const observer = () => renderPanels(listBox);
    Services.prefs.addObserver(DATA_PREF, observer);
    win.addEventListener("unload", () => {
      try {
        Services.prefs.removeObserver(DATA_PREF, observer);
      } catch { /* already gone */ }
    });
  } catch (e) {
    console.error("[derp-panes] panel list observer failed:", e);
  }
}

function init(): void {
  ensureBoolPref(ENABLED_PREF);
  queuePrefsUpdate();
}

const ICON = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="context-fill" fill-opacity="context-fill-opacity"><path fill-rule="evenodd" d="M2 3.5A1.5 1.5 0 0 1 3.5 2H6v12H3.5A1.5 1.5 0 0 1 2 12.5v-9zM7.25 2h5.25A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5H7.25V2zm1.25 1.25v9.5h4a.25.25 0 0 0 .25-.25v-9a.25.25 0 0 0-.25-.25h-4z"/></svg>`,
);

export function registerSidebarPane(): void {
  const ok = addDerpPane({
    category: "paneDerpSidebar",
    categoryId: "category-derp-sidebar",
    label: "Panel Sidebar",
    icon: ICON,
    build,
    init,
  });
  log("sidebar pane:", ok ? "registered" : "FAILED");
}
