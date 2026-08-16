/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PanelSidebarStaticNames } from "../utils/panel-sidebar-static-names";
import type { PanelSidebarConfig } from "../utils/type";

const BORK_HELP_URL = "chrome://noraneko-help/content/index.html";

/**
 * Profiles created before bork shipped its own help still hold a panel
 * pointing at upstream's documentation site, and changing the default only
 * affects new profiles. Repoint those panels at the local help instead —
 * matched on host so it catches whichever docs page the panel had settled on.
 */
export function migrateHelpPanelUrl() {
  try {
    const raw = Services.prefs.getStringPref(
      PanelSidebarStaticNames.panelSidebarDataPrefName,
      "",
    );
    if (!raw || !raw.includes("docs.floorp.app")) return;

    const sidebar = JSON.parse(raw) as NewSidebar;
    let changed = false;
    for (const panel of sidebar.data ?? []) {
      if (panel.url?.includes("docs.floorp.app")) {
        panel.url = BORK_HELP_URL;
        changed = true;
      }
    }
    if (!changed) return;

    Services.prefs.setStringPref(
      PanelSidebarStaticNames.panelSidebarDataPrefName,
      JSON.stringify(sidebar),
    );
    console.log("[panel-sidebar] Help panel repointed at the local help pages");
  } catch (e) {
    console.error("[panel-sidebar] Failed to migrate the help panel URL", e);
  }
}

/**
 * Retire web panels.
 *
 * A web panel did not show a page — it showed a whole nested
 * chrome://browser/content/browser.xhtml with the page inside it, a second
 * browser UI living in the sidebar and laid out in the parent process for the
 * entire session. bork's panel is links, so the type is gone.
 *
 * bork's own help shipped as one, so that is repointed at the static panel
 * that replaces it. Anything else a user added is dropped: there is nothing
 * left to render it with, and leaving it would be a button that opens nothing.
 */
export function migrateWebPanelsAway() {
  try {
    const pref = PanelSidebarStaticNames.panelSidebarDataPrefName;
    const raw = Services.prefs.getStringPref(pref, "");
    if (!raw || !raw.includes('"web"')) return;

    const sidebar = JSON.parse(raw) as NewSidebar;
    const panels = sidebar.data ?? [];
    let changed = false;
    const kept = [];

    for (const panel of panels) {
      if (panel.type !== "web") {
        kept.push(panel);
        continue;
      }
      changed = true;
      if (panel.url === BORK_HELP_URL) {
        panel.type = "static";
        panel.url = "bork//help";
        kept.push(panel);
      }
    }

    if (!changed) return;
    sidebar.data = kept;
    Services.prefs.setStringPref(pref, JSON.stringify(sidebar));
    console.log(
      `[panel-sidebar] retired ${panels.length - kept.length} web panel(s)`,
    );
  } catch (e) {
    console.error("[panel-sidebar] Failed to retire web panels", e);
  }
}

export function migratePanelSidebarData() {
  const oldData = Services.prefs.getCharPref(
    "floorp.browser.sidebar2.data",
    undefined,
  );

  if (oldData) {
    const newSidebar = convertSidebar(JSON.parse(oldData) as OldSidebar);
    Services.prefs.setStringPref(
      PanelSidebarStaticNames.panelSidebarDataPrefName,
      JSON.stringify(newSidebar),
    );

    Services.prefs.clearUserPref("floorp.browser.sidebar2.data");

    // Create a new config
    const globalWidth = Services.prefs.getIntPref(
      "floorp.browser.sidebar2.global.webpanel.width",
      400,
    );

    const autoUnload = Services.prefs.getBoolPref(
      "floorp.browser.sidebar2.hide.to.unload.panel.enabled",
      false,
    );

    const position_start = Services.prefs.getBoolPref(
      "floorp.browser.sidebar.right",
      true,
    );

    let displayed = Services.prefs.getBoolPref(
      "floorp.browser.sidebar.is.displayed",
      true,
    );
    const enabled = Services.prefs.getBoolPref(
      "floorp.browser.sidebar.enable",
      true,
    );

    if (!enabled || !displayed) {
      // If either the old 'enable' pref or 'displayed' pref is false, set displayed to false.
      // This ensures that if the sidebar was previously disabled or hidden, it remains so.
      displayed = false;
    }

    const config: PanelSidebarConfig = {
      globalWidth,
      autoUnload,
      position_start,
      displayed,
      webExtensionRunningEnabled: false,
    };

    Services.prefs.setStringPref(
      PanelSidebarStaticNames.panelSidebarConfigPrefName,
      JSON.stringify(config),
    );
  }
}

type OldSidebarData = {
  url: string;
  width?: number;
  usercontext?: number;
  zoomLevel?: number;
};

type OldSidebar = {
  data: { [key: string]: OldSidebarData };
  index: string[];
};

type NewSidebarItem = {
  id: string;
  type: "extension" | "static" | "web";
  width: number;
  url: string;
  userContextId: number | null;
  zoomLevel: number | null;
};

type NewSidebar = {
  data: NewSidebarItem[];
};

export function convertSidebar(oldSidebar: OldSidebar): NewSidebar {
  const newSidebar: NewSidebar = { data: [] };

  oldSidebar.index.forEach((key) => {
    const item = oldSidebar.data[key];
    const url = item.url;
    let type: "extension" | "static" | "web";
    const id = key;
    let width = item.width || 0;
    const userContextId = item.usercontext || null;
    const zoomLevel = item.zoomLevel || null;

    if (url.startsWith("extension")) {
      type = "extension";
      width = width || 450;
    } else if (url.startsWith("floorp//")) {
      type = "static";
    } else {
      type = "web";
    }

    newSidebar.data.push({
      id,
      type,
      width,
      url,
      userContextId,
      zoomLevel,
    });
  });

  return newSidebar;
}
