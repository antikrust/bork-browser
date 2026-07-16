/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For } from "solid-js";
import { panelSidebarData } from "../data/data";
import { PanelSidebarButton } from "./sidebar-panel-button";
import { showPanelSidebarAddModal } from "./panel-sidebar-modal";
import type { CPanelSidebar } from "./panel-sidebar";
import { WorkspacesPanels } from "../../workspaces/toolbar/workspaces-panels.tsx";

export function SidebarSelectbox(props: { ctx: CPanelSidebar }) {
  return (
    <xul:vbox
      id="panel-sidebar-select-box"
      class="webpanel-box chromeclass-extrachrome chromeclass-directories instant customization-target"
    >
      <xul:toolbarbutton
        class="panel-sidebar-panel"
        id="derp-sidebar-menu-icon"
        onCommand={() => {
          const anchor = document?.getElementById("derp-sidebar-menu-icon");
          const panelUI = (globalThis as unknown as {
            PanelUI?: {
              showSubView: (viewId: string, anchor: Element) => void;
            };
          }).PanelUI;
          try {
            if (anchor && panelUI?.showSubView) {
              panelUI.showSubView("appMenu-mainView", anchor);
            }
          } catch (e) {
            console.error("[panel-sidebar] Failed to open app menu:", e);
          }
        }}
      />
      <WorkspacesPanels />
      <For each={panelSidebarData()}>
        {(panel) => <PanelSidebarButton panel={panel} ctx={props.ctx} />}
      </For>
      <xul:toolbarbutton
        id="panel-sidebar-add"
        class="panel-sidebar-panel"
        onCommand={() => {
          showPanelSidebarAddModal();
        }}
      />
      <xul:spacer flex="1" />
      <xul:vbox id="panel-sidebar-bottomButtonBox">
        <xul:toolbarbutton
          class="panel-sidebar-panel"
          id="derp-sidebar-reopen-icon"
          onCommand={() => {
            try {
              (globalThis as unknown as { undoCloseTab?: () => void })
                .undoCloseTab?.();
            } catch (e) {
              console.error("[panel-sidebar] Failed to reopen tab:", e);
            }
          }}
        />
        <xul:toolbarbutton
          class="panel-sidebar-panel"
          id="derp-sidebar-account-icon"
          onCommand={() => {
            const anchor = document?.getElementById(
              "derp-sidebar-account-icon",
            );
            const panelUI = (globalThis as unknown as {
              PanelUI?: {
                showSubView: (viewId: string, anchor: Element) => void;
              };
            }).PanelUI;
            try {
              if (anchor && panelUI?.showSubView) {
                panelUI.showSubView("PanelUI-fxa", anchor);
              }
            } catch (e) {
              console.error(
                "[panel-sidebar] Failed to open account panel:",
                e,
              );
            }
          }}
        />
        <xul:toolbarbutton
          class="panel-sidebar-panel"
          onCommand={() => {
            // derp: pop the unified extensions panel (icon list, includes
            // "Manage extensions") at this button instead of jumping
            // straight to the addons admin page.
            const anchor = document?.getElementById(
              "panel-sidebar-addons-icon",
            );
            const panelUI = (globalThis as unknown as {
              PanelUI?: {
                showSubView: (viewId: string, anchor: Element) => void;
              };
            }).PanelUI;
            try {
              if (anchor && panelUI?.showSubView) {
                panelUI.showSubView("unified-extensions-view", anchor);
                return;
              }
            } catch (e) {
              console.error(
                "[panel-sidebar] Failed to open extensions panel:",
                e,
              );
            }
            globalThis.BrowserAddonUI.openAddonsMgr("addons://list/extension");
          }}
          id="panel-sidebar-addons-icon"
        />
        <xul:toolbarbutton
          class="panel-sidebar-panel"
          onCommand={() =>
            globalThis.gBrowser.addTrustedTab("about:logins", {
              inBackground: false,
            })}
          id="panel-sidebar-passwords-icon"
        />
        <xul:toolbarbutton
          class="panel-sidebar-panel"
          onCommand={() => globalThis.openPreferences()}
          id="panel-sidebar-preferences-icon"
        />
      </xul:vbox>
    </xul:vbox>
  );
}
