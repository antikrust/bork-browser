/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Panel Sidebar pane — a read-only view of the saved panels
 * (floorp.panelSidebar.data) with per-panel delete. Full panel management
 * (add/edit/reorder) stays in the sidebar itself. The old Basic Settings
 * block is gone: the feature is hardcoded on, panels stay loaded when
 * closed, and the global web-panel width default stands (see the feature
 * layer — data.ts forces panelSidebar.enabled, panel-sidebar.tsx no longer
 * unloads on close).
 *
 * Text mirrors the hub's en-US strings; i18n wiring is a follow-up for all
 * derp panes at once.
 */

import {
  addDerpPane,
  doc,
  groupboxOf,
  log,
  paneHeader,
  queuePrefsUpdate,
  win,
} from "./framework.ts";

// The Basic Settings block (enable toggle, unload-on-close, global width)
// is gone — those are hardcoded now: the sidebar is always enabled, panels
// stay loaded when closed, and the global web-panel width default (400)
// stands. Only the saved-panel list remains manageable here.
const DATA_PREF = "floorp.panelSidebar.data";

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

/* ------------------------------------------------------------------ */
/* Pane                                                                */
/* ------------------------------------------------------------------ */

function build(root: Element): void {
  root.appendChild(paneHeader(
    "Panel Sidebar",
    "Panel Sidebar is a feature that allows you to display various tools, websites, and extensions on the side of the window. Here, you can customize, add, delete, and manage panels.",
  ));

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
