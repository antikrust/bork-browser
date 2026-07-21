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

    const refreshFromEvent = (event: Event) => {
      // Use popupNode if available (set by the rail), otherwise
      // explicitOriginalTarget (toolbar chooser rows).
      const chromeDoc = document as ChromeDocument;
      let target = (chromeDoc.popupNode ??
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
            }
          }}
        >
          <ContextMenu
            disableBefore={disableBefore()}
            disableAfter={disableAfter()}
            contextWorkspaceId={contextWorkspaceId()!}
            ctx={this.ctx}
          />
        </xul:menupopup>
      </xul:popupset>
    );
  }
}
