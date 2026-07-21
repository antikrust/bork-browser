/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Workspaces pane — port of the hub's workspaces settings page
 * (pages-settings/src/app/workspaces): one native bool pref plus four
 * toggles stored in the floorp.workspaces.v4.config JSON pref.
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
  readJsonPref,
  writeJsonPrefField,
} from "./framework.ts";

const ENABLED_PREF = "floorp.workspaces.enabled";
const CONFIG_PREF = "floorp.workspaces.v4.config";

function configCheckbox(
  id: string,
  field: string,
  label: string,
  description: string,
): Element {
  return checkboxRow({
    id,
    label,
    description,
    checked: () => readJsonPref(CONFIG_PREF)[field] !== false, // hub defaults: on
    onChange: (checked) => writeJsonPrefField(CONFIG_PREF, field, checked),
  });
}

function build(root: Element): void {
  root.appendChild(paneHeader(
    "Workspaces",
    "Workspaces let you group tabs and switch between sets without separate windows.",
  ));

  root.appendChild(groupboxOf("Basic settings", [
    checkboxRow({
      id: "derp-workspaces-enabled",
      label: "Enable Workspaces",
      preference: ENABLED_PREF,
    }),
    configCheckbox(
      "derp-workspaces-close-popup",
      "closePopupAfterClick",
      "Close popup when selecting a workspace",
      "Closes the workspaces popup after you pick one.",
    ),
  ]));
  // showWorkspaceNameOnToolbar and the workspaces sidebar toggles live in the
  // workspaces button's right-click menu now; "leave workspace when its last
  // tab closes" is hardcoded behavior rather than an option.

  root.appendChild(importGroup());
}

/* ---- Import from Vivaldi (port of the hub's ImportSettings) ----
   Onboarding offers this too, but an existing profile never sees onboarding
   again, so this is the entry point that stays reachable. The actual import
   runs in the browser window's chrome layer; we signal it with the same
   window events the old settings RPC used. */

function importGroup(): Element {
  const status = doc.createElement("p");
  status.id = "derp-workspaces-import-status";
  status.className = "description-deemphasized";
  status.style.marginBlock = "4px 0";

  const group = groupboxOf("Import from Vivaldi", [
    (() => {
      const desc = doc.createElement("p");
      desc.className = "description-deemphasized";
      desc.style.marginBlock = "0 8px";
      desc.textContent =
        "Recreate your Vivaldi workspaces here, along with the tabs inside them. Workspaces you already have are skipped, so this tops up rather than duplicating.";
      return desc;
    })(),
    (() => {
      const row = doc.createXULElement("hbox");
      row.setAttribute("align", "center");
      const btn = doc.createXULElement("button");
      btn.id = "derp-workspaces-import-vivaldi";
      btn.setAttribute("label", "Import workspaces");
      btn.addEventListener("command", () => {
        void runVivaldiImport(btn, status);
      });
      row.appendChild(btn);
      return row;
    })(),
    status,
  ]);
  group.id = "derp-workspaces-import-group";
  (group as unknown as { hidden: boolean }).hidden = true; // shown when Vivaldi found
  return group;
}

async function vivaldiAvailable(): Promise<boolean> {
  try {
    const { MigrationUtils } = ChromeUtils.importESModule(
      "resource:///modules/MigrationUtils.sys.mjs",
    ) as {
      MigrationUtils: {
        availableMigratorKeys: string[];
        getMigrator: (key: string) => Promise<unknown>;
      };
    };
    if (!MigrationUtils.availableMigratorKeys.includes("vivaldi")) return false;
    return !!(await MigrationUtils.getMigrator("vivaldi"));
  } catch {
    return false;
  }
}

async function runVivaldiImport(
  btn: Element,
  status: HTMLElement,
): Promise<void> {
  btn.setAttribute("disabled", "true");
  status.textContent = "Importing…";
  try {
    const win = Services.wm.getMostRecentWindow("navigator:browser") as
      | (Window & { CustomEvent: typeof CustomEvent })
      | null;
    if (!win) throw new Error("no browser window");
    const done = new Promise<{ workspacesCreated?: number; tabsRestored?: number }>(
      (resolve, reject) => {
        const timer = win.setTimeout(
          () => reject(new Error("import timed out")),
          120000,
        );
        win.addEventListener(
          "derp-vivaldi-import-done",
          (e: Event) => {
            win.clearTimeout(timer);
            resolve((e as CustomEvent).detail ?? {});
          },
          { once: true },
        );
      },
    );
    win.dispatchEvent(new win.CustomEvent("derp-vivaldi-import"));
    const result = await done;
    status.textContent = `Created ${result.workspacesCreated ?? 0} workspaces with ${
      result.tabsRestored ?? 0
    } tabs.`;
  } catch (e) {
    console.error("[derp-panes] vivaldi import failed:", e);
    status.textContent = "That import did not finish. Nothing was changed.";
  } finally {
    btn.removeAttribute("disabled");
  }
}

function init(): void {
  ensureBoolPref(ENABLED_PREF);
  queuePrefsUpdate();
  // Only offer the Vivaldi import when a Vivaldi profile exists.
  void vivaldiAvailable().then((ok) => {
    const group = doc.getElementById("derp-workspaces-import-group");
    if (group && ok) (group as unknown as { hidden: boolean }).hidden = false;
  });
}

const ICON = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="context-fill" fill-opacity="context-fill-opacity"><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h3A1.5 1.5 0 0 1 8 3.5v3A1.5 1.5 0 0 1 6.5 8h-3A1.5 1.5 0 0 1 2 6.5v-3zm1.5-.25a.25.25 0 0 0-.25.25v3c0 .138.112.25.25.25h3a.25.25 0 0 0 .25-.25v-3a.25.25 0 0 0-.25-.25h-3zM9.5 2A1.5 1.5 0 0 0 8 3.5v3A1.5 1.5 0 0 0 9.5 8h3A1.5 1.5 0 0 0 14 6.5v-3A1.5 1.5 0 0 0 12.5 2h-3zm-.25 1.5c0-.138.112-.25.25-.25h3a.25.25 0 0 1 .25.25v3a.25.25 0 0 1-.25.25h-3a.25.25 0 0 1-.25-.25v-3zM2 9.5A1.5 1.5 0 0 1 3.5 8h3A1.5 1.5 0 0 1 8 9.5v3A1.5 1.5 0 0 1 6.5 14h-3A1.5 1.5 0 0 1 2 12.5v-3zm1.5-.25a.25.25 0 0 0-.25.25v3c0 .138.112.25.25.25h3a.25.25 0 0 0 .25-.25v-3a.25.25 0 0 0-.25-.25h-3zM9.5 8A1.5 1.5 0 0 0 8 9.5v3A1.5 1.5 0 0 0 9.5 14h3a1.5 1.5 0 0 0 1.5-1.5v-3A1.5 1.5 0 0 0 12.5 8h-3zm-.25 1.5c0-.138.112-.25.25-.25h3a.25.25 0 0 1 .25.25v3a.25.25 0 0 1-.25.25h-3a.25.25 0 0 1-.25-.25v-3z"/></svg>`,
);

export function registerWorkspacesPane(): void {
  const ok = addDerpPane({
    category: "paneDerpWorkspaces",
    categoryId: "category-derp-workspaces",
    label: "Workspaces",
    icon: ICON,
    build,
    init,
  });
  log("workspaces pane:", ok ? "registered" : "FAILED");
}
