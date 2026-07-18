/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { WorkspacesService } from "./workspacesService.ts";
import { workspacesDataStore } from "./data/data.ts";

interface VivaldiTab {
  workspaceId: number;
  url: string;
  title?: string;
}

interface VivaldiWorkspace {
  id: number;
  name: string;
  emoji?: string;
  icon?: string;
}

interface VivaldiImportData {
  workspaces: VivaldiWorkspace[];
  tabs: VivaldiTab[];
}

const { readVivaldiData } = ChromeUtils.importESModule(
  "resource://noraneko/modules/VivaldiImport.sys.mjs",
) as { readVivaldiData: () => Promise<VivaldiImportData> };

export interface VivaldiImportResult {
  workspacesCreated: number;
  tabsRestored: number;
  /** Names skipped because a workspace already had them. */
  skipped: string[];
}

/**
 * Recreate Vivaldi's workspaces here, with their tabs.
 *
 * Tabs are created lazily: a hundred-plus restored tabs would otherwise all
 * start loading at once. Vivaldi's own icons are inline SVG and derp's are a
 * fixed named set, so imported workspaces keep the neutral default glyph and
 * only carry the name across.
 */
export async function importVivaldiWorkspaces(
  ctx: WorkspacesService,
): Promise<VivaldiImportResult> {
  const result: VivaldiImportResult = {
    workspacesCreated: 0,
    tabsRestored: 0,
    skipped: [],
  };

  const data = await readVivaldiData();
  if (!data.workspaces.length) return result;

  const tabsByWorkspace = new Map<number, VivaldiTab[]>();
  for (const tab of data.tabs) {
    const list = tabsByWorkspace.get(tab.workspaceId);
    if (list) list.push(tab);
    else tabsByWorkspace.set(tab.workspaceId, [tab]);
  }

  // Match on name so running the import twice tops up rather than duplicating.
  const existingNames = new Set<string>();
  for (const id of workspacesDataStore.order) {
    const name = ctx.getRawWorkspace(id)?.name;
    if (name) existingNames.add(name);
  }

  for (const workspace of data.workspaces) {
    if (existingNames.has(workspace.name)) {
      result.skipped.push(workspace.name);
      continue;
    }

    const id = ctx.createWorkspace(workspace.name);
    result.workspacesCreated++;

    for (const tab of tabsByWorkspace.get(workspace.id) ?? []) {
      // Vivaldi records internal pages (chrome://vivaldi-data/... thumbnails
      // among them) that mean nothing here.
      if (!/^https?:\/\//i.test(tab.url)) continue;
      try {
        const newTab = globalThis.gBrowser.addTab(tab.url, {
          createLazyBrowser: true,
          lazyTabTitle: tab.title,
          inBackground: true,
          skipAnimation: true,
          triggeringPrincipal: Services.scriptSecurityManager
            .getSystemPrincipal(),
        });
        ctx.tabManagerCtx.setWorkspaceIdToAttribute(newTab, id);
        result.tabsRestored++;
      } catch (e) {
        console.error("[VivaldiImport] Could not restore", tab.url, e);
      }
    }
  }

  ctx.tabManagerCtx.updateTabsVisibility();
  return result;
}

let bridgeRegistered = false;

/**
 * The onboarding import box runs in a content page and cannot reach the
 * workspaces service, so it asks the browser window instead and this answers.
 */
export function registerVivaldiImportBridge(ctx: WorkspacesService): void {
  if (bridgeRegistered) return;
  bridgeRegistered = true;

  const win = globalThis as unknown as Window;
  win.addEventListener("derp-vivaldi-import", () => {
    const reply = (detail: VivaldiImportResult) =>
      win.dispatchEvent(
        new CustomEvent("derp-vivaldi-import-done", { detail }),
      );
    importVivaldiWorkspaces(ctx)
      .then(reply)
      .catch((e) => {
        console.error("[VivaldiImport] Bridge request failed", e);
        reply({ workspacesCreated: 0, tabsRestored: 0, skipped: [] });
      });
  });
}

/** Whether there is anything to offer importing, for hiding the entry point. */
export async function hasVivaldiWorkspaces(): Promise<boolean> {
  try {
    return (await readVivaldiData()).workspaces.length > 0;
  } catch (e) {
    console.error("[VivaldiImport] Could not inspect the Vivaldi profile", e);
    return false;
  }
}
