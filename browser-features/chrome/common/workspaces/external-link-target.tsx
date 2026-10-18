/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { render } from "@nora/solid-xul";
import i18next from "i18next";
import { createSignal } from "solid-js";
import { isRight } from "fp-ts/Either";
import { addI18nObserver } from "#i18n/config-browser-chrome.ts";
import type { WorkspacesService } from "./workspacesService.ts";
import {
  type TExternalLinkTarget,
  type TWorkspaceID,
  zExternalLinkTarget,
} from "./utils/type.ts";
import { WORKSPACE_EXTERNAL_LINK_TARGET_PREF_NAME } from "./utils/workspaces-static-names.ts";

const translationKey = "workspaces.menu.openExternalLinksHere";

/**
 * "Open Links from Other Apps Here" on the tab context menu. Marking a tab
 * records its workspace + container; from then on a link handed to the
 * browser by another app opens as a new tab in that workspace, in that
 * container, instead of in a default-container tab of the current workspace.
 *
 * Other apps reach the browser through BrowserContentHandler's
 * handURIToExistingBrowser, which calls `openURI` with OPEN_EXTERNAL on the
 * top window's BrowserDOMWindow, the one point every external open passes through.
 */
export class WorkspacesExternalLinkTarget {
  ctx: WorkspacesService;

  constructor(ctx: WorkspacesService) {
    this.ctx = ctx;
    this.interceptExternalOpens();

    const tabContextMenu = document.getElementById("tabContextMenu")!;
    const [label, setLabel] = createSignal(i18next.t(translationKey));
    addI18nObserver(() => setLabel(i18next.t(translationKey)));
    render(
      () => (
        <xul:menuitem
          id="context_openExternalLinksHere"
          type="checkbox"
          label={label()}
          onCommand={(event: Event) =>
            this.onCommand(event.target as XULElement)}
        />
      ),
      tabContextMenu,
      { marker: document.getElementById("context_moveTabOptions")! },
    );
    tabContextMenu.addEventListener("popupshowing", (event) => {
      if (event.target !== tabContextMenu) return;
      const item = document.getElementById("context_openExternalLinksHere")!;
      const target = this.liveTarget();
      const tab = globalThis.TabContextMenu.contextTab as XULElement;
      const marked = target !== null &&
        target.workspaceId ===
          this.ctx.tabManagerCtx.getWorkspaceIdFromAttribute(tab) &&
        target.userContextId === userContextIdOf(tab);
      item.setAttribute("checked", String(marked));
    });
  }

  private onCommand(item: XULElement) {
    if (item.getAttribute("checked") !== "true") {
      Services.prefs.clearUserPref(WORKSPACE_EXTERNAL_LINK_TARGET_PREF_NAME);
      return;
    }
    const tab = globalThis.TabContextMenu.contextTab as XULElement;
    const target: TExternalLinkTarget = {
      workspaceId: this.ctx.tabManagerCtx.getWorkspaceIdFromAttribute(tab)!,
      userContextId: userContextIdOf(tab),
    };
    Services.prefs.setStringPref(
      WORKSPACE_EXTERNAL_LINK_TARGET_PREF_NAME,
      JSON.stringify(target),
    );
  }

  /** The stored target, or null when none is set or its workspace is gone. */
  private liveTarget(): {
    workspaceId: TWorkspaceID;
    userContextId: number;
  } | null {
    const raw = Services.prefs.getStringPref(
      WORKSPACE_EXTERNAL_LINK_TARGET_PREF_NAME,
      "",
    );
    if (!raw) return null;
    const decoded = zExternalLinkTarget.decode(JSON.parse(raw));
    if (!isRight(decoded)) return null;
    const target = decoded.right;
    if (!this.ctx.isWorkspaceID(target.workspaceId)) {
      Services.prefs.clearUserPref(WORKSPACE_EXTERNAL_LINK_TARGET_PREF_NAME);
      return null;
    }
    return {
      workspaceId: target.workspaceId,
      userContextId: target.userContextId,
    };
  }

  private interceptExternalOpens() {
    // window.browserDOMWindow reflects as an XPConnect wrapper whose interface
    // methods are read-only; the JS BrowserDOMWindow behind it is where the
    // XPCOM call from BrowserContentHandler looks `openURI` up.
    const browserDOMWindow = window.browserDOMWindow.wrappedJSObject;
    const nativeOpenURI = browserDOMWindow.openURI.bind(browserDOMWindow);
    browserDOMWindow.openURI = (
      uri: nsIURI,
      openWindowInfo: nsIOpenWindowInfo | null,
      where: number,
      flags: number,
      triggeringPrincipal: nsIPrincipal,
      policyContainer: nsIPolicyContainer | null,
    ) => {
      const target = flags & Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL
        ? this.liveTarget()
        : null;
      if (!target) {
        return nativeOpenURI(
          uri,
          openWindowInfo,
          where,
          flags,
          triggeringPrincipal,
          policyContainer,
        );
      }

      const tab = globalThis.gBrowser.addTab(uri.spec, {
        triggeringPrincipal,
        policyContainer,
        userContextId: target.userContextId,
        fromExternal: true,
      });
      this.ctx.tabManagerCtx.setWorkspaceIdToAttribute(tab, target.workspaceId);
      this.ctx.changeWorkspace(target.workspaceId);
      globalThis.gBrowser.selectedTab = tab;
      window.focus();
      return tab.linkedBrowser.browsingContext;
    };
  }
}

function userContextIdOf(tab: XULElement): number {
  return Number.parseInt(tab.getAttribute("usercontextid") || "0", 10);
}
