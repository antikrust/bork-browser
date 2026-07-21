/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For } from "solid-js";
import { panelSidebarData } from "../data/data";
import { PanelSidebarButton } from "./sidebar-panel-button";
import { showPanelSidebarAddModal } from "./panel-sidebar-modal";
import type { CPanelSidebar } from "./panel-sidebar";
import {
  ExtensionTweaker,
  toggleExtensionTweaker,
} from "./extension-tweaker.tsx";

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
      {/* Workspaces moved to the left rail (workspaces/toolbar/
          workspaces-rail.tsx) — manageOnBms renders nothing here. */}
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
        {/* derp: inline extension tweaker — the icon column slides up out
            of this box in place of the stock unified-extensions popup. */}
        <ExtensionTweaker />
        <xul:toolbarbutton
          class="panel-sidebar-panel"
          onCommand={() => toggleExtensionTweaker()}
          id="panel-sidebar-addons-icon"
        />
        <xul:toolbarbutton
          class="panel-sidebar-panel"
          onCommand={() => {
            // Toggle, same shape as the settings gear below: pressing
            // while you're looking at Passwords closes that tab.
            const gb = globalThis.gBrowser;
            let current = "";
            try {
              current = gb.selectedBrowser?.currentURI?.spec ?? "";
            } catch {
              // lazy/teardown browser — treat as not-passwords
            }
            if (current.startsWith("about:logins")) {
              gb.removeTab(gb.selectedTab);
              return;
            }
            // Reuse a Passwords tab already open in THIS window (manual
            // scan — switchToTabHavingURI searches every window).
            for (const tab of gb.tabs) {
              let spec = "";
              try {
                spec = tab.linkedBrowser?.currentURI?.spec ?? "";
              } catch {
                continue;
              }
              if (spec.startsWith("about:logins")) {
                gb.selectedTab = tab;
                return;
              }
            }
            gb.addTrustedTab("about:logins", { inBackground: false });
          }}
          id="panel-sidebar-passwords-icon"
        />
        <xul:toolbarbutton
          class="panel-sidebar-panel"
          onCommand={() => {
            // Toggle: first press opens Settings, pressing again while
            // you're looking at it closes it (the tab), not a re-open.
            const gb = globalThis.gBrowser;
            let current = "";
            try {
              current = gb.selectedBrowser?.currentURI?.spec ?? "";
            } catch {
              // lazy/teardown browser — treat as not-settings
            }
            if (
              current.startsWith("about:settings") ||
              current.startsWith("about:preferences")
            ) {
              gb.removeTab(gb.selectedTab);
            } else {
              globalThis.openPreferences();
            }
          }}
          id="panel-sidebar-preferences-icon"
        />
      </xul:vbox>
    </xul:vbox>
  );
}
