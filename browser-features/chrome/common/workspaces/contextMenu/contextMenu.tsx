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
      <xul:menuitem
        type="checkbox"
        label="Show workspace name"
        checked={configStore.showWorkspaceNameOnToolbar}
        onCommand={() =>
          setConfigStore(
            "showWorkspaceNameOnToolbar",
            !configStore.showWorkspaceNameOnToolbar,
          )}
      />
      <xul:menuitem
        type="checkbox"
        label="Workspaces sidebar"
        checked={configStore.manageOnBms}
        onCommand={() => setConfigStore("manageOnBms", !configStore.manageOnBms)}
      />
    </>
  );
}
