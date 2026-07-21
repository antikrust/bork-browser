/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { TWorkspaceID } from "../utils/type";
import { startInlineRename } from "../toolbar/popup-block-element.tsx";
import type { WorkspacesService } from "../workspacesService";
import i18next from "i18next";
import { createSignal } from "solid-js";
import { addI18nObserver } from "#i18n/config-browser-chrome.ts";
import { configStore, setConfigStore } from "../data/config.ts";

const { CustomizableUI } = ChromeUtils.importESModule(
  "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
);

const translationKeys = {
  moveUp: "workspaces.context-menu.move-up",
  moveDown: "workspaces.context-menu.move-down",
  rename: "workspaces.context-menu.rename",
  delete: "workspaces.context-menu.delete",
  manage: "workspaces.context-menu.manage",
  archive: "workspaces.context-menu.archive",
};

const translate = (
  key: string,
  options?: Record<string, unknown>,
): string => i18next.t(key, options) as string;

const getTranslations = () => ({
  moveUp: translate(translationKeys.moveUp),
  moveDown: translate(translationKeys.moveDown),
  rename: translate(translationKeys.rename),
  delete: translate(translationKeys.delete),
  manage: translate(translationKeys.manage),
  archive: translate(translationKeys.archive),
});

export function ContextMenu(props: {
  disableBefore: boolean;
  disableAfter: boolean;
  contextWorkspaceId: TWorkspaceID;
  ctx: WorkspacesService;
  /** Bumped by the owner on every popupshowing — non-reactive reads
   * (CustomizableUI placement) key off it to refresh per open. */
  openTick: number;
}) {
  const [texts, setTexts] = createSignal(getTranslations());

  addI18nObserver(() => {
    setTexts(getTranslations());
  });

  return (
    <>
      <xul:menuitem
        label={texts().moveUp}
        disabled={props.disableBefore}
        onCommand={() => props.ctx.reorderWorkspaceUp(props.contextWorkspaceId)}
      />
      <xul:menuitem
        label={texts().moveDown}
        disabled={props.disableAfter}
        onCommand={() =>
          props.ctx.reorderWorkspaceDown(props.contextWorkspaceId)}
      />
      <xul:menuseparator class="workspaces-context-menu-separator" />
      <xul:menuitem
        label={texts().rename}
        onCommand={() => {
          // Same inline editor as double-click. The popup must survive the
          // menu closing, so start on the next tick; if the row is gone
          // (popup dismissed), fall back to the manage dialog.
          setTimeout(() => {
            if (!startInlineRename(props.contextWorkspaceId)) {
              props.ctx.manageWorkspaceFromDialog(props.contextWorkspaceId);
            }
          }, 0);
        }}
      />
      <xul:menuitem
        label={texts().delete}
        onCommand={() => props.ctx.deleteWorkspace(props.contextWorkspaceId)}
      />
      <xul:menuitem
        label={texts().manage}
        onCommand={() =>
          props.ctx.manageWorkspaceFromDialog(props.contextWorkspaceId)}
      />
      {/* No Set Icon submenu: icon (and colour) live in the Manage
          Workspace dialog. The 34-item iconic submenu was also the prime
          suspect for native segfaults on submenu hover-open (see
          project memory, 2026-07-21). */}
      <xul:menuseparator class="workspaces-context-menu-separator" />
      <xul:menuitem
        label={texts().archive}
        onCommand={async () => {
          await props.ctx.archiveWorkspace(props.contextWorkspaceId);
        }}
      />
      <xul:menuseparator />
      {/* Display toggles, moved here from the settings page: the store's
          persistence effect writes them back to floorp.workspaces.v4.config. */}
      {/* XUL shows a tick for ANY present checked attribute — the string
          "false" still ticks — so false must remove the attribute
          entirely (undefined), never write it. */}
      <xul:menuitem
        type="checkbox"
        label="Show workspace name"
        checked={configStore.showWorkspaceNameOnToolbar ? "true" : undefined}
        onCommand={() =>
          setConfigStore(
            "showWorkspaceNameOnToolbar",
            !configStore.showWorkspaceNameOnToolbar,
          )}
      />
      <xul:menuitem
        type="checkbox"
        label="Workspaces sidebar"
        checked={configStore.manageOnBms ? "true" : undefined}
        onCommand={() => setConfigStore("manageOnBms", !configStore.manageOnBms)}
      />
      {/* Quick recovery for a chooser dragged out in customize mode —
          and the deliberate way to run rail-only. openTick re-reads the
          non-reactive CustomizableUI placement on every open. */}
      <xul:menuitem
        type="checkbox"
        label="Workspaces in tab bar"
        checked={props.openTick >= 0 &&
            CustomizableUI.getPlacementOfWidget("workspaces-toolbar-button")
          ? "true"
          : undefined}
        onCommand={() => {
          const placed = !!CustomizableUI.getPlacementOfWidget(
            "workspaces-toolbar-button",
          );
          if (placed) {
            CustomizableUI.removeWidgetFromArea("workspaces-toolbar-button");
          } else {
            CustomizableUI.addWidgetToArea(
              "workspaces-toolbar-button",
              "TabsToolbar",
              0,
            );
          }
        }}
      />
    </>
  );
}
