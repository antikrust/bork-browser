/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ContextMenuUtils } from "#features-chrome/utils/context-menu.tsx";
import { createRoot, getOwner, type Owner, runWithOwner } from "solid-js";
import type { WorkspacesService } from "../workspacesService.ts";
import { ContextMenu } from "./contextMenu.tsx";
import { createSignal } from "solid-js";
import type { TWorkspaceID } from "../utils/type.ts";
import { configStore, setConfigStore } from "../data/config.ts";

const { CustomizableUI } = ChromeUtils.importESModule(
  "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
);

type ChromeDocument = Document & { popupNode?: Element | null };

export class WorkspacesPopupContextMenu {
  ctx: WorkspacesService;
  constructor(ctx: WorkspacesService) {
    this.ctx = ctx;
    const owner: Owner | null = getOwner();
    const exec = () =>
      ContextMenuUtils.addToolbarContentMenuPopupSet(() => this.PopupSet());
    if (owner) runWithOwner(owner, exec);
    else createRoot(exec);
    this.ensureToolbarWorkspacesMenu();
  }

  /**
   * A "Workspaces" submenu in the TOOLBAR context menu carrying the
   * display toggles — reachable even when both the chooser and the rail
   * are gone (the "accidentally removed the workspaces tab" recovery).
   * Static DOM, built once; checked states refresh per open (XUL ticks
   * show for ANY present checked attribute, so false = attribute gone).
   */
  private ensureToolbarWorkspacesMenu(): void {
    const MENU_ID = "derp-workspaces-toolbar-menu";
    const CHOOSER_ID = "workspaces-toolbar-button";
    const toolbarMenu = document?.getElementById("toolbar-context-menu");
    if (!toolbarMenu || document?.getElementById(MENU_ID)) return;
    const doc = document as Document & {
      createXULElement: (tag: string) => XULElement;
    };
    const menu = doc.createXULElement("menu");
    menu.id = MENU_ID;
    menu.setAttribute("label", "Workspaces");
    const popup = doc.createXULElement("menupopup");
    const items: Array<{ node: XULElement; isChecked: () => boolean }> = [];
    const makeToggle = (
      label: string,
      isChecked: () => boolean,
      toggle: () => void,
    ): void => {
      const item = doc.createXULElement("menuitem");
      item.setAttribute("type", "checkbox");
      item.setAttribute("label", label);
      item.addEventListener("command", toggle);
      popup.appendChild(item);
      items.push({ node: item, isChecked });
    };
    makeToggle(
      "Show workspace name",
      () => !!configStore.showWorkspaceNameOnToolbar,
      () =>
        setConfigStore(
          "showWorkspaceNameOnToolbar",
          !configStore.showWorkspaceNameOnToolbar,
        ),
    );
    makeToggle(
      "Workspaces sidebar",
      () => !!configStore.manageOnBms,
      () => setConfigStore("manageOnBms", !configStore.manageOnBms),
    );
    makeToggle(
      "Workspaces in tab bar",
      () => !!CustomizableUI.getPlacementOfWidget(CHOOSER_ID),
      () => {
        if (CustomizableUI.getPlacementOfWidget(CHOOSER_ID)) {
          CustomizableUI.removeWidgetFromArea(CHOOSER_ID);
        } else {
          CustomizableUI.addWidgetToArea(CHOOSER_ID, "TabsToolbar", 0);
        }
      },
    );
    toolbarMenu.addEventListener("popupshowing", (event: Event) => {
      if (event.target !== toolbarMenu) return;
      for (const { node, isChecked } of items) {
        if (isChecked()) node.setAttribute("checked", "true");
        else node.removeAttribute("checked");
      }
    });
    menu.appendChild(popup);
    toolbarMenu.appendChild(menu);
  }

  private PopupSet() {
    // The menu DOM is STATIC — built once and reused for every open.
    // popupshowing only refreshes these signals. The previous shape tore
    // every child out and re-rendered the tree inside popupshowing,
    // mutating the popup while the native macOS menu (nsMenuX) was mid
    // construction — implicated in parent-process segfaults with this
    // exact menu open (two identical SIGSEGV stacks on 2026-07-21).
    const [contextWorkspaceId, setContextWorkspaceId] = createSignal<
      TWorkspaceID | null
    >(null);
    const [disableBefore, setDisableBefore] = createSignal(false);
    const [disableAfter, setDisableAfter] = createSignal(false);
    const [openTick, setOpenTick] = createSignal(0);

    const refreshFromEvent = (event: Event) => {
      // Resolution order matters. triggerNode is what the popup manager
      // recorded for THIS open (context= attribute opens and any
      // openPopup* call passed a trigger event). popupNode is only a
      // fallback — and is consumed on read, because it otherwise goes
      // stale: one rail right-click left it pointing at that rail button
      // forever, so chooser-row opens resolved the wrong workspace and
      // Delete silently did nothing from the tab-bar chooser.
      const chromeDoc = document as ChromeDocument;
      const popup = event.target as (Element & {
        triggerNode?: Element | null;
      });
      const staleFallback = chromeDoc.popupNode ?? null;
      chromeDoc.popupNode = null;
      let target = (popup.triggerNode ??
        staleFallback ??
        (event as Event & { explicitOriginalTarget?: Element })
          .explicitOriginalTarget) as Element | null;
      while (target && !target.id?.startsWith("workspace-")) {
        target = target.parentElement;
      }
      if (!target) return;
      const id = target.id.replace("workspace-", "");
      if (this.ctx.isWorkspaceID(id)) {
        setContextWorkspaceId(id);
      }
      const before = target.previousElementSibling?.getAttribute(
        "data-workspaceId",
      ) ?? null;
      const after = target.nextElementSibling?.getAttribute(
        "data-workspaceId",
      ) ?? null;
      setDisableBefore(before === null);
      setDisableAfter(after === null);
    };

    return (
      <xul:popupset>
        <xul:menupopup
          id="workspaces-toolbar-item-context-menu"
          onPopupShowing={(event: Event) => {
            // Only the outermost popup's showing refreshes state — the
            // Set Icon submenu bubbles its own popupshowing through here.
            if (
              (event.target as Element | null)?.id ===
                "workspaces-toolbar-item-context-menu"
            ) {
              refreshFromEvent(event);
              setOpenTick((t) => t + 1);
            }
          }}
        >
          <ContextMenu
            disableBefore={disableBefore()}
            disableAfter={disableAfter()}
            contextWorkspaceId={contextWorkspaceId()!}
            ctx={this.ctx}
            openTick={openTick()}
          />
        </xul:menupopup>
      </xul:popupset>
    );
  }
}
