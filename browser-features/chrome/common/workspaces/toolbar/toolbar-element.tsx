/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BrowserActionUtils } from "#features-chrome/utils/browser-action.tsx";
import { PopupElement } from "./popup-element.tsx";
import workspacesStyles from "./styles.css?inline";
import {
  createEffect,
  createRoot,
  getOwner,
  type JSX,
  onCleanup,
  runWithOwner,
} from "solid-js";
import type { WorkspacesService } from "../workspacesService.ts";
import { configStore, enabled } from "../data/config.ts";
import Workspaces from "../index.ts";
import { selectedWorkspaceID, workspacesDataStore } from "../data/data.ts";
import { getContainerColorName } from "../utils/container-color.ts";

const { CustomizableUI } = ChromeUtils.importESModule(
  "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
);

import { CHEVRON_ICON, LAYERS_ICON } from "./icons.ts";

let lastDisplayedWorkspaceId: string | null = null;

export class WorkspacesToolbarButton {
  private StyleElement = () => {
    return <style>{workspacesStyles}</style>;
  };

  constructor(ctx: WorkspacesService) {
    const owner = getOwner();
    BrowserActionUtils.createMenuToolbarButton(
      "workspaces-toolbar-button",
      "workspaces-toolbar-button",
      "workspacesToolbarButtonPanel",
      <PopupElement ctx={ctx} />,
      null,
      () => {
        const exec = () => {
          // derp: the chooser lives at the far left of the tab strip,
          // Vivaldi-style. Re-pin it if customization state drifted.
          try {
            const placement = CustomizableUI.getPlacementOfWidget(
              "workspaces-toolbar-button",
            );
            if (
              !placement ||
              placement.area !== CustomizableUI.AREA_TABSTRIP ||
              placement.position !== 0
            ) {
              CustomizableUI.addWidgetToArea(
                "workspaces-toolbar-button",
                CustomizableUI.AREA_TABSTRIP,
                0,
              );
            }
          } catch (e) {
            console.error("[workspaces] Failed to pin toolbar button:", e);
          }

          setTimeout(() => this.updateButtonIfNeeded(true), 500);

          createEffect(() => {
            const _ = configStore.showWorkspaceNameOnToolbar;
            const __ = enabled();
            this.updateButtonIfNeeded();
          });

          createEffect(() => {
            const _ = selectedWorkspaceID();
            this.updateButtonIfNeeded();
          });

          // Watch for workspace data changes to update button when name changes
          createEffect(() => {
            const _ = workspacesDataStore.data;
            // Force update when workspace data changes
            this.updateButtonIfNeeded(true);
          });
        };
        if (owner) runWithOwner(owner, exec);
        else createRoot(exec);
      },
      CustomizableUI.AREA_TABSTRIP,
      this.StyleElement() as JSX.Element,
      0,
    );

    const setupInterval = () => {
      const intervalId = setInterval(() => this.updateButtonIfNeeded(), 500);
      onCleanup(() => clearInterval(intervalId));
    };
    if (owner) runWithOwner(owner, setupInterval);
    else createRoot(setupInterval);
  }

  private getButtonNode(): Element | null {
    if (!document) return null;
    const all = document.querySelectorAll("#workspaces-toolbar-button");
    if (all.length <= 1) return all[0] ?? null;

    // CustomizableUI rebuilds the widget node on area/placement changes, and
    // the startup re-pin can race that rebuild, stranding a second bare 18px
    // button beside the real one (the "phantom box" — clicks still opened the
    // popup because both nodes carry the widget wiring).
    //
    // Document order is NOT safe to sweep by: mid-rebuild the replacement is
    // inserted before the outgoing node is unhooked, so the first node can be
    // the one on its way out — removing "the rest" then deletes the live
    // button and the chooser vanishes until the next rebuild. Ask
    // CustomizableUI which node it owns and only ever remove the others.
    let owned: Element | null = null;
    try {
      owned = CustomizableUI.getWidget("workspaces-toolbar-button")
        ?.forWindow(globalThis as unknown as Window)?.node ?? null;
    } catch (e) {
      console.error("[workspaces] Failed to resolve owned button node:", e);
    }
    if (!owned?.isConnected) return all[0] ?? null;

    for (const node of all) {
      if (node !== owned) node.remove();
    }
    return owned;
  }

  private updateButtonIfNeeded(force = false) {
    const aNode = this.getButtonNode();
    if (!aNode) return;

    try {
      const ctx = Workspaces.getCtx();
      if (!ctx) return;

      const currentId = ctx.getSelectedWorkspaceID();
      if (!currentId) return;

      if (!force && lastDisplayedWorkspaceId === currentId) return;

      lastDisplayedWorkspaceId = currentId;

      const workspace = ctx.getRawWorkspace(currentId);
      if (!workspace) return;
      const icon = ctx.iconCtx.getWorkspaceIconUrl(workspace.icon);
      const xulElement = aNode as unknown as XULElement;

      // The default workspace always shows the neutral stacked-layers
      // glyph (Vivaldi-style); everything else falls back to it too when
      // no icon is set — never the branding logo.
      const isDefault = ctx.getDefaultWorkspaceID() === currentId;
      const iconSrc = isDefault ? LAYERS_ICON : (icon || LAYERS_ICON);
      xulElement.style.setProperty("list-style-image", `url(${iconSrc})`);
      // The native toolbarbutton icon slot doesn't render on this button in
      // the tab strip, so we own the icon: a dedicated <image> injected as
      // the first child, always left of the name. The native slots are
      // hidden in styles.css so this can never double up.
      let derpIcon = xulElement.querySelector(
        ".derp-workspaces-chooser-icon",
      ) as XULElement | null;
      if (!derpIcon) {
        derpIcon = document!.createXULElement("image") as XULElement;
        derpIcon.classList.add("derp-workspaces-chooser-icon");
        xulElement.insertBefore(derpIcon, xulElement.firstChild);
      }
      if (derpIcon.getAttribute("src") !== iconSrc) {
        derpIcon.setAttribute("src", iconSrc);
      }

      // Chevron after the name: the chooser is a menu and should read as
      // one. Appended last so it always sits right of the label text.
      let chevron = xulElement.querySelector(
        ".derp-workspaces-chooser-chevron",
      ) as XULElement | null;
      if (!chevron) {
        chevron = document!.createXULElement("image") as XULElement;
        chevron.classList.add("derp-workspaces-chooser-chevron");
        chevron.setAttribute("src", CHEVRON_ICON);
        xulElement.appendChild(chevron);
      }

      if (configStore.showWorkspaceNameOnToolbar) {
        xulElement.setAttribute("label", workspace.name);
      } else {
        xulElement.removeAttribute("label");
      }
      if (!enabled()) {
        xulElement.setAttribute("hidden", "true");
      } else {
        xulElement.removeAttribute("hidden");
      }

      // Set container color attributes
      const userContextId = workspace.userContextId ?? 0;
      const hasContainer = userContextId > 0;
      const containerColorName = getContainerColorName(userContextId);
      xulElement.setAttribute(
        "data-has-container",
        hasContainer ? "true" : "false",
      );
      xulElement.setAttribute(
        "data-container-color",
        containerColorName ?? "",
      );
    } catch (e) {
      console.error("Error updating workspace toolbar button:", e);
    }
  }
}
