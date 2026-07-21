/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {
  createEffect,
  createRoot,
  getOwner,
  onCleanup,
  runWithOwner,
} from "solid-js";
import { selectedWorkspaceID } from "./data/data.ts";
import type {
  PanelMultiViewParentElement,
  TWorkspaceID,
} from "./utils/type.ts";
import { zWorkspaceID } from "./utils/type.ts";
import {
  WORKSPACE_LAST_SHOW_ID,
  WORKSPACE_PENDING_EXIT_PREF_NAME,
  WORKSPACE_TAB_ATTRIBUTION_ID,
} from "./utils/workspaces-static-names.ts";
import { configStore, enabled } from "./data/config.ts";
import type { WorkspaceIcons } from "./utils/workspace-icons.ts";
import type { WorkspacesDataManager } from "./workspacesDataManagerBase.tsx";
import { isRight } from "fp-ts/Either";

interface TabEvent extends Event {
  target: XULElement;
  forUnsplit?: boolean;
}

export class WorkspacesTabManager {
  dataManagerCtx: WorkspacesDataManager;
  iconCtx: WorkspaceIcons;
  // When true, handleTabClose skips its workspace-empty logic. Used during
  // bulk tab removal (workspace deletion) so that closing tabs one-by-one
  // does not interfere with the deletion flow (fixes #2247).
  private suppressTabCloseHandling = false;
  constructor(iconCtx: WorkspaceIcons, dataManagerCtx: WorkspacesDataManager) {
    this.iconCtx = iconCtx;
    this.dataManagerCtx = dataManagerCtx;
    this.boundHandleTabClose = this.handleTabClose.bind(this);
    this.boundHandleTabOpen = this.handleTabOpen.bind(this);

    const initWorkspace = () => {
      (
        globalThis as unknown as {
          SessionStore: { promiseAllWindowsRestored: Promise<void> };
        }
      ).SessionStore.promiseAllWindowsRestored
        .then(() => {
          this.initializeWorkspace();
          this.installRemoveTabGuard();
          globalThis.addEventListener("TabClose", this.boundHandleTabClose as EventListener);
          globalThis.addEventListener("TabOpen", this.boundHandleTabOpen);
        })
        .catch((error: Error) => {
          console.error("Error waiting for windows restore:", error);
          this.initializeWorkspace();
          this.installRemoveTabGuard();
          globalThis.addEventListener("TabClose", this.boundHandleTabClose as EventListener);
          globalThis.addEventListener("TabOpen", this.boundHandleTabOpen);
        });
    };

    initWorkspace();

    // Migration: this feature used to FORCE browser.tabs.closeWindowWithLastTab
    // to false so a workspace could never be empty — which also meant closing a
    // window's last tab spawned a replacement instead of closing the window.
    // Workspaces may be empty now (a tab is created only when one is selected,
    // in changeWorkspace), so restore Firefox's natural close-on-last-tab by
    // clearing the user value the old code wrote into existing profiles.
    try {
      const prefName = "browser.tabs.closeWindowWithLastTab";
      if (Services.prefs.prefHasUserValue(prefName)) {
        Services.prefs.clearUserPref(prefName);
      }
    } catch (e) {
      console.warn(
        "WorkspacesTabManager: failed to clear closeWindowWithLastTab pref",
        e,
      );
    }

    const owner = getOwner?.();
    const exec = () =>
      createEffect(() => {
        if (!enabled()) {
          return;
        }

        if (selectedWorkspaceID()) {
          this.updateTabsVisibility();
        }
      });
    if (owner) runWithOwner(owner, exec);
    else createRoot(exec);

    onCleanup(() => {
      this.cleanup();
    });
  }

  private initializeWorkspace() {
    // Collapse duplicated startup "new" tabs when last exit was triggered by
    // workspace-empty quit. This prevents two blank/home tabs after restart.
    try {
      if (Services.prefs.getBoolPref(WORKSPACE_PENDING_EXIT_PREF_NAME, false)) {
        const homepage = Services.prefs.getStringPref(
          "browser.startup.homepage",
          "",
        );
        const isStartupNewURL = (url: string): boolean => {
          const u = url || "";
          return (
            u === "about:newtab" ||
            u === "about:home" ||
            u === "about:blank" ||
            (homepage !== "" && u === homepage)
          );
        };
        const tabs = (globalThis.gBrowser.tabs as XULElement[]) || [];
        const startupNewTabs: XULElement[] = [];
        for (const t of tabs) {
          try {
            const browser = globalThis.gBrowser.getBrowserForTab(t);
            const currentUrl = browser?.currentURI?.spec || "";
            if (isStartupNewURL(currentUrl)) {
              startupNewTabs.push(t);
            }
          } catch {
            // ignore
          }
        }
        if (startupNewTabs.length >= 2) {
          // Suppress handleTabClose to avoid interference during cleanup
          this.suppressTabCloseHandling = true;
          try {
            // Keep first, remove the rest
            for (let i = 1; i < startupNewTabs.length; i++) {
              try {
                globalThis.gBrowser.removeTab(startupNewTabs[i]);
              } catch {
                // ignore
              }
            }
          } finally {
            this.suppressTabCloseHandling = false;
          }
        }
        Services.prefs.setBoolPref(WORKSPACE_PENDING_EXIT_PREF_NAME, false);
      }
    } catch (e) {
      console.debug(
        "WorkspacesTabManager: failed collapsing startup duplicates",
        e,
      );
    }

    const startupTab = globalThis.gBrowser.selectedTab as XULElement | null;
    let maybeSelectedWorkspace = startupTab
      ? this.getWorkspaceIdFromAttribute(startupTab)
      : null;

    // A selected tab carrying no workspace attribute did not come from session
    // restore (restored tabs keep theirs) — it is a link the OS handed us while
    // the browser was still starting. Adopt it into whichever workspace we are
    // about to open, so changeWorkspace's "selection already belongs here" path
    // keeps it. Without this, changeWorkspace restores that workspace's
    // last-shown tab — or its first tab — over the top of the link the user
    // just clicked.
    const tabToAdopt = maybeSelectedWorkspace ? null : startupTab;

    if (!maybeSelectedWorkspace) {
      maybeSelectedWorkspace = this.getMaybeSelectedWorkspacebyVisibleTabs();
    }
    if (maybeSelectedWorkspace) {
      if (tabToAdopt) {
        this.setWorkspaceIdToAttribute(tabToAdopt, maybeSelectedWorkspace);
      }
      this.changeWorkspace(maybeSelectedWorkspace);
    } else {
      try {
        const defaultWorkspaceId = this.dataManagerCtx.getDefaultWorkspaceID();
        if (tabToAdopt) {
          this.setWorkspaceIdToAttribute(tabToAdopt, defaultWorkspaceId);
        }
        this.changeWorkspace(defaultWorkspaceId);
      } catch (e) {
        console.error("Failed to change workspace:", e);
        // Fallback: create default workspace when store is empty or invalid
        try {
          const createdId = this.dataManagerCtx.createWorkspace("Workspace");
          this.dataManagerCtx.setDefaultWorkspace(createdId);
          this.changeWorkspace(createdId);
        } catch (createErr) {
          console.error(
            "Failed to create and switch to default workspace:",
            createErr,
          );
        }
      }
    }
  }

  private boundHandleTabClose: (event: TabEvent) => void;
  private boundHandleTabOpen: (event: Event) => void;

  public cleanup() {
    globalThis.removeEventListener("TabClose", this.boundHandleTabClose as EventListener);
    globalThis.removeEventListener("TabOpen", this.boundHandleTabOpen);
    if (this.origRemoveTab) {
      (globalThis.gBrowser as unknown as Record<string, unknown>).removeTab =
        this.origRemoveTab;
      this.origRemoveTab = null;
    }
  }

  private origRemoveTab:
    | ((tab: XULElement, params?: unknown) => void)
    | null = null;

  /**
   * Firefox treats closing the last VISIBLE tab as closing the window — and
   * with workspaces, the other workspaces' tabs are hidden, so they don't
   * save it. (That is why this feature used to force
   * closeWindowWithLastTab=false, which traded the bug for "the window
   * refuses to close and spawns a tab".) Intercept instead: when the closing
   * tab is the last visible one but hidden workspace tabs remain, leave the
   * emptied workspace FIRST — changeWorkspace unhides the target's tabs, so
   * Firefox never sees a last-tab close. The emptied workspace stays in the
   * store with zero tabs until it is selected again. A genuine last tab
   * (nothing hidden either) falls through untouched and closes the window
   * naturally.
   */
  private installRemoveTabGuard() {
    const gb = globalThis.gBrowser as unknown as {
      removeTab: (tab: XULElement, params?: unknown) => void;
      tabs: XULElement[];
      visibleTabs?: XULElement[];
    };
    if (this.origRemoveTab) return;
    const orig = gb.removeTab.bind(globalThis.gBrowser);
    this.origRemoveTab = gb.removeTab;
    gb.removeTab = (tab: XULElement, params?: unknown) => {
      try {
        if (
          enabled() &&
          !this.suppressTabCloseHandling &&
          tab &&
          !(tab as unknown as { hidden: boolean }).hidden
        ) {
          const visible = gb.visibleTabs ??
            gb.tabs.filter((t) =>
              !(t as unknown as { hidden: boolean }).hidden
            );
          if (
            visible.length === 1 &&
            visible[0] === tab &&
            gb.tabs.length > 1
          ) {
            const emptiedId = this.getWorkspaceIdFromAttribute(tab) ??
              this.dataManagerCtx.getSelectedWorkspaceID();
            // Hardcoded policy: leaving an emptied workspace goes to the
            // default workspace; when the DEFAULT one empties, to the next
            // workspace that still has tabs.
            let targetId: TWorkspaceID | null = this.dataManagerCtx
              .getDefaultWorkspaceID();
            if (!targetId || targetId === emptiedId) {
              // The workspace of the first remaining (hidden) tab.
              const other = gb.tabs.find((t) =>
                t !== tab &&
                this.getWorkspaceIdFromAttribute(t) !== emptiedId
              );
              targetId = other
                ? this.getWorkspaceIdFromAttribute(other)
                : null;
            }
            if (targetId && targetId !== emptiedId) {
              this.changeWorkspace(targetId);
            }
          }
        }
      } catch (e) {
        console.error("WorkspacesTabManager: removeTab guard failed", e);
      }
      return orig(tab, params);
    };
  }

  private handleTabClose = (event: TabEvent) => {
    // Skip workspace-empty logic when bulk-removing tabs (e.g. workspace deletion)
    if (this.suppressTabCloseHandling) return;

    const tab = event.target as XULElement;
    let workspaceId = this.getWorkspaceIdFromAttribute(tab);

    // If the tab has no workspace attribute, assign it to the current workspace
    // so that the "last tab close" logic can still fire correctly (fixes #2201).
    if (!workspaceId) {
      const currentId = this.dataManagerCtx.getSelectedWorkspaceID();
      if (currentId) {
        workspaceId = currentId;
      } else {
        return;
      }
    }

    const currentWorkspaceId = this.dataManagerCtx.getSelectedWorkspaceID();
    const isCurrentWorkspace = workspaceId === currentWorkspaceId;
    const allTabs = globalThis.gBrowser.tabs as XULElement[];

    const resolveWorkspaceIdForClose = (
      targetTab: XULElement,
    ): TWorkspaceID => {
      return this.getWorkspaceIdFromAttribute(targetTab) ?? currentWorkspaceId;
    };
    const workspaceTabs = allTabs.filter((t) => {
      return t !== tab && resolveWorkspaceIdForClose(t) === workspaceId;
    });

    const validWorkspaceTabs = workspaceTabs.filter((t) => {
      // Firefox auto-creates a "replacement" tab (blank page in the default
      // container) right before firing TabClose when
      // browser.tabs.closeWindowWithLastTab=false. Such tabs have no user
      // value and must not prevent the "workspace becoming empty" detection.
      // Earlier code tried to identify them by creation timestamp, but that is
      // unreliable: Firefox creates the replacement *before* TabClose fires,
      // and a replacement left over from a previous close also looks "old".
      // Instead, identify replacements by their stable intrinsic features:
      // blank/newtab URL + default container + not pinned.
      // Container-switch / reopen tabs (fixes #2193) are created in the
      // workspace's *target* container, so they keep userContextId > 0 and are
      // never misclassified here.
      return !this.isAutoReplacementTab(t as unknown as XULElement);
    });

    if (isCurrentWorkspace && validWorkspaceTabs.length === 0) {
      // The current workspace is becoming empty. Empty workspaces are fine:
      // they stay in the store with zero tabs and get a fresh tab only when
      // the user selects them again (changeWorkspace, Priority 4). Never
      // respawn a tab here.
      const otherWorkspaceTabs = allTabs.filter((t) => {
        if (t === tab) return false;
        return resolveWorkspaceIdForClose(t) !== workspaceId;
      });

      if (otherWorkspaceTabs.length === 0) {
        // That was the window's last tab. closeWindowWithLastTab is no longer
        // forced off, so Firefox closes the window itself — doing anything
        // here (creating a tab, selecting) would fight that.
        return;
      }

      // Other workspaces still have tabs. Follow the user off the emptied
      // workspace: to the default workspace when exitOnLastTabClose asks for
      // it, otherwise to wherever Firefox moves the selection (its tab's
      // workspace). Deferred so gBrowser finishes settling the selection
      // first.
      setTimeout(() => {
        try {
          // Hardcoded: back to the default workspace (or wherever Firefox
          // moved the selection when the default one itself emptied).
          let targetId: TWorkspaceID | null = this.dataManagerCtx
            .getDefaultWorkspaceID();
          if (!targetId || targetId === workspaceId) {
            const selected = globalThis.gBrowser
              .selectedTab as XULElement | null;
            targetId = (selected && this.getWorkspaceIdFromAttribute(selected)) ??
              null;
          }
          if (targetId && targetId !== workspaceId) {
            this.changeWorkspace(targetId);
          } else {
            this.updateTabsVisibility();
          }
        } catch (e) {
          console.error(
            "WorkspacesTabManager: failed to leave emptied workspace",
            e,
          );
        }
      }, 0);
    }
  };

  private handleTabOpen = (event: Event) => {
    try {
      const tab = (event as CustomEvent).target as XULElement;
      const wsId = this.getWorkspaceIdFromAttribute(tab) ??
        this.dataManagerCtx.getSelectedWorkspaceID();
      if (!this.getWorkspaceIdFromAttribute(tab)) {
        this.setWorkspaceIdToAttribute(tab, wsId);
      }
    } catch {
      // ignore tab-open handler error
    }
  };

  public updateTabsVisibility() {
    const currentWorkspaceId = this.dataManagerCtx.getSelectedWorkspaceID();
    const selectedTab = globalThis.gBrowser.selectedTab;
    if (
      selectedTab &&
      !selectedTab.hasAttribute(WORKSPACE_LAST_SHOW_ID) &&
      selectedTab.getAttribute(WORKSPACE_TAB_ATTRIBUTION_ID) ===
      currentWorkspaceId
    ) {
      const lastShowWorkspaceTabs = document?.querySelectorAll(
        `[${WORKSPACE_LAST_SHOW_ID}="${currentWorkspaceId}"]`,
      );

      if (lastShowWorkspaceTabs) {
        for (const lastShowWorkspaceTab of lastShowWorkspaceTabs) {
          lastShowWorkspaceTab.removeAttribute(WORKSPACE_LAST_SHOW_ID);
        }
      }

      selectedTab.setAttribute(WORKSPACE_LAST_SHOW_ID, currentWorkspaceId);
    }

    // Check Tabs visibility
    const tabs = globalThis.gBrowser.tabs as Array<
      XULElement | undefined | null
    >;
    for (const tab of tabs) {
      if (!tab) continue;
      // Set workspaceId if workspaceId is null
      const workspaceId = this.getWorkspaceIdFromAttribute(tab);
      if (!workspaceId) {
        this.setWorkspaceIdToAttribute(tab, currentWorkspaceId);
      }

      const chackedWorkspaceId = this.getWorkspaceIdFromAttribute(tab);
      if (chackedWorkspaceId === currentWorkspaceId) {
        globalThis.gBrowser.showTab(tab);
      } else {
        globalThis.gBrowser.hideTab(tab);
      }
    }

    // Hide tab groups that have no visible tabs, show those that do
    const tabGroups = globalThis.gBrowser.tabGroups;
    for (const group of tabGroups) {
      const hasVisibleTabInGroup = (group.tabs as Array<XULElement>)
        .some((tab) => this.getWorkspaceIdFromAttribute(tab) === currentWorkspaceId);
      group.style.display = hasVisibleTabInGroup ? "" : "none";
    }

    // Hide split view wrappers that have no visible tabs, show those that do
    const splitViewWrappers = document.querySelectorAll(
      "tab-split-view-wrapper",
    );
    for (const wrapper of splitViewWrappers) {
      const children = Array.from(wrapper.children) as Element[];
      const hasVisibleTabInWrapper = children.some(
        (child) => {
          if (child.tagName !== "tab") return false;
          return (
            this.getWorkspaceIdFromAttribute(child as XULElement) ===
            currentWorkspaceId
          );
        },
      );
      (wrapper as HTMLElement).style.display = hasVisibleTabInWrapper
        ? ""
        : "none";
    }
  }

  /**
   * Get workspaceId from tab attribute.
   * @param tab The tab.
   * @returns The workspace id.
   */
  getWorkspaceIdFromAttribute(tab: XULElement): TWorkspaceID | null {
    const raw = tab.getAttribute(WORKSPACE_TAB_ATTRIBUTION_ID);
    if (!raw) {
      return null;
    }
    const clean = raw.replace(/[{}]/g, "");
    const parseResult = zWorkspaceID.decode(clean);
    if (!isRight(parseResult)) {
      console.warn("WorkspacesTabManager: invalid workspace id format:", raw);
      return null;
    }
    const wsId = parseResult.right;
    if (!this.dataManagerCtx.isWorkspaceID(wsId)) {
      console.warn(
        "WorkspacesTabManager: workspace id not found in store:",
        wsId,
      );
      return null;
    }
    return wsId;
  }

  /**
   * Set workspaceId to tab attribute.
   * @param tab The tab.
   * @param workspaceId The workspace id.
   */
  setWorkspaceIdToAttribute(tab: XULElement, workspaceId: TWorkspaceID) {
    tab.setAttribute(WORKSPACE_TAB_ATTRIBUTION_ID, workspaceId);
  }

  /**
   * Detect whether a tab is an auto-created Firefox "replacement" tab.
   *
   * When `browser.tabs.closeWindowWithLastTab` is forced to false (which this
   * feature does), Firefox spawns a blank replacement tab *before* firing
   * TabClose to keep the window from going empty. Such tabs have no user value
   * and must not block the "workspace becoming empty" detection.
   *
   * Replacements are identified by stable intrinsic features rather than by
   * creation timestamp (which proved unreliable — Firefox creates the
   * replacement before TabClose fires, and one left over from a previous close
   * looks old). Specifically: blank/newtab URL + default container (no
   * userContextId) + not pinned.
   *
   * Tabs created by container-switch / reopen logic (#2193) and "Open Link in
   * New Tab" always carry a real userContextId or a non-blank URL, so they are
   * never misclassified as replacements here.
   */
  private isAutoReplacementTab(tab: XULElement): boolean {
    try {
      // Pinned tabs are never auto-replacements.
      if (tab.getAttribute("pinned") === "true") return false;

      // Replacement tabs are always created in the default container.
      // Any non-zero userContextId means it is a user/container tab.
      const userContextId = Number.parseInt(
        tab.getAttribute("usercontextid") || "0",
        10,
      );
      if (userContextId > 0) return false;

      const browser = globalThis.gBrowser.getBrowserForTab(
        tab as unknown as XULElement,
      );
      const url = browser?.currentURI?.spec || "";
      // Replacement tabs are blank / newtab / home pages.
      const isBlankOrNewTab = !url ||
        url === "about:blank" ||
        url === "about:newtab" ||
        url === "about:home";
      return isBlankOrNewTab;
    } catch (e) {
      console.error(
        "WorkspacesTabManager: error checking if tab is auto-replacement",
        e,
      );
      // On error, assume NOT a replacement so we never accidentally treat a
      // real user tab as disposable.
      return false;
    }
  }

  /**
   * Remove tab by workspace id.
   * @param workspaceId The workspace id.
   * @param fallbackWorkspaceId Optional fallback workspace id used when
   * deleting the current/default workspace.
   */
  public removeTabByWorkspaceId(
    workspaceId: TWorkspaceID,
    fallbackWorkspaceId?: TWorkspaceID,
  ) {
    const tabs = globalThis.gBrowser.tabs;
    const tabsToRemove = [];

    for (const tab of tabs) {
      const tabWorkspaceId = this.getWorkspaceIdFromAttribute(tab);
      if (tabWorkspaceId === workspaceId) {
        tabsToRemove.push(tab);
      }
    }

    if (tabsToRemove.length === 0) return;

    // Suppress handleTabClose workspace-empty logic so that closing tabs
    // during workspace deletion does not create spurious replacement tabs
    // or switch workspaces unexpectedly (fixes #2247).
    this.suppressTabCloseHandling = true;
    try {
      const currentWorkspaceId = this.dataManagerCtx.getSelectedWorkspaceID();
      if (workspaceId === currentWorkspaceId) {
        const defaultId = this.dataManagerCtx.getDefaultWorkspaceID();
        const targetWorkspaceId = defaultId !== workspaceId
          ? defaultId
          : fallbackWorkspaceId && fallbackWorkspaceId !== workspaceId
            ? fallbackWorkspaceId
            : null;

        if (targetWorkspaceId) {
          const defaultTabs = document?.querySelectorAll(
            `[${WORKSPACE_TAB_ATTRIBUTION_ID}="${targetWorkspaceId}"]`,
          ) as NodeListOf<XULElement>;

          if (defaultTabs?.length > 0) {
            globalThis.gBrowser.selectedTab = defaultTabs[0];
          } else {
            this.createTabForWorkspace(targetWorkspaceId, true);
          }

          this.dataManagerCtx.setCurrentWorkspaceID(targetWorkspaceId);
          this.updateTabsVisibility();
        }
      }

      for (let i = tabsToRemove.length - 1; i >= 0; i--) {
        try {
          globalThis.gBrowser.removeTab(tabsToRemove[i]);
        } catch (e) {
          console.error("Error removing tab:", e);
        }
      }
    } finally {
      this.suppressTabCloseHandling = false;
    }
  }

  /**
   * Create tab for workspace.
   * @param workspaceId The workspace id.
   * @param url The url will be opened in the tab.
   * @param select will select tab if true.
   * @returns The created tab.
   */
  createTabForWorkspace(
    workspaceId: TWorkspaceID,
    select = false,
    url?: string,
  ) {
    const targetURL = url ??
      Services.prefs.getStringPref("browser.startup.homepage");

    // Look up workspace's container to create the tab in the correct context.
    // Without this, replacement tabs for container workspaces are created in
    // the default container, causing proxy/VPN tabs to stop working (#2193).
    const workspace = this.dataManagerCtx.getRawWorkspace(workspaceId);
    const userContextId = workspace?.userContextId ?? 0;

    const tab = globalThis.gBrowser.addTab(targetURL, {
      skipAnimation: true,
      inBackground: false,
      userContextId: userContextId > 0 ? userContextId : undefined,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    this.setWorkspaceIdToAttribute(tab, workspaceId);

    if (userContextId > 0) {
      tab.setAttribute("usercontextid", String(userContextId));
    }

    if (select) {
      globalThis.gBrowser.selectedTab = tab;
    }
    return tab;
  }

  /**
   * Change workspace. Selected workspace id will be stored in window object.
   * @param workspaceId The workspace id.
   */
  public changeWorkspace(workspaceId: TWorkspaceID) {
    if (
      configStore.closePopupAfterClick &&
      this.targetToolbarItem?.hasAttribute("open")
    ) {
      this.panelUITargetElement?.hidePopup();
    }

    // Persist the currently selected tab as the last-shown for the
    // previously selected workspace before switching. This ensures we can
    // restore focus when returning to that workspace instead of creating
    // a new tab each time.
    try {
      const prevWorkspaceId = this.dataManagerCtx.getSelectedWorkspaceID();
      const currentlySelectedTab = globalThis.gBrowser
        .selectedTab as XULElement | null;
      if (
        currentlySelectedTab &&
        this.getWorkspaceIdFromAttribute(currentlySelectedTab) ===
        prevWorkspaceId
      ) {
        currentlySelectedTab.setAttribute(
          WORKSPACE_LAST_SHOW_ID,
          prevWorkspaceId,
        );
      }
    } catch (e) {
      console.debug(
        "WorkspacesTabManager: failed to persist previous workspace last-show",
        e,
      );
    }

    try {
      // Priority 1: If the currently selected tab already belongs to the
      // target workspace, keep it.  This preserves SessionStore's correct
      // startup selection and avoids overriding it with the first tab in
      // DOM order (which is a pinned tab after restore, causing #2053).
      const currentTab = globalThis.gBrowser.selectedTab as XULElement | null;
      const currentTabInTargetWorkspace = currentTab &&
        this.getWorkspaceIdFromAttribute(currentTab) === workspaceId;

      if (currentTabInTargetWorkspace) {
        // Keep the existing selection — SessionStore (or a previous switch)
        // already chose the correct tab for this workspace.
      } else {
        // Priority 2: Use the last-shown tab for this workspace.
        const willChangeWorkspaceLastShowTab = document?.querySelector(
          `[${WORKSPACE_LAST_SHOW_ID}="${workspaceId}"]`,
        ) as XULElement;

        if (willChangeWorkspaceLastShowTab) {
          globalThis.gBrowser.selectedTab = willChangeWorkspaceLastShowTab;
        } else {
          // Priority 3: Fall back to the first tab in this workspace.
          const tabToSelect = this.workspaceHasTabs(workspaceId);
          if (tabToSelect) {
            globalThis.gBrowser.selectedTab = tabToSelect;
          } else {
            // Priority 4: Claim an unattributed tab or create a new one.
            const nonWorkspaceTab = this.isThereNoWorkspaceTabs();
            if (nonWorkspaceTab !== true) {
              globalThis.gBrowser.selectedTab = nonWorkspaceTab as XULElement;
              this.setWorkspaceIdToAttribute(
                nonWorkspaceTab as XULElement,
                workspaceId,
              );
            } else {
              this.createTabForWorkspace(workspaceId, true);
            }
          }
        }
      }
      this.dataManagerCtx.setCurrentWorkspaceID(workspaceId);
      this.updateTabsVisibility();
    } catch (e) {
      console.error("Failed to change workspace:", e);

      try {
        const defaultId = this.dataManagerCtx.getDefaultWorkspaceID();

        if (defaultId !== workspaceId) {
          this.createTabForWorkspace(defaultId, true);
          this.dataManagerCtx.setCurrentWorkspaceID(defaultId);
          this.updateTabsVisibility();
        } else {
          this.createTabForWorkspace(workspaceId, true);
          this.dataManagerCtx.setCurrentWorkspaceID(workspaceId);
          this.updateTabsVisibility();
        }
      } catch (innerError) {
        console.error("Critical error handling workspace change:", innerError);

        try {
          console.debug("gBrowser.addTab called in changeWorkspace");
          const newTab = globalThis.gBrowser.addTab("about:newtab", {
            skipAnimation: true,
            triggeringPrincipal: Services.scriptSecurityManager
              .getSystemPrincipal(),
          });
          globalThis.gBrowser.selectedTab = newTab;
        } catch (finalError) {
          console.error("Fatal error creating new tab:", finalError);
        }
      }
    }
  }

  /**
   * Switch to another workspace tab.
   * @param workspaceId The workspace id.
   * @returns void
   */
  switchToAnotherWorkspaceTab(workspaceId: TWorkspaceID) {
    const workspaceTabs = Array.from(
      document?.querySelectorAll(
        `[${WORKSPACE_TAB_ATTRIBUTION_ID}="${workspaceId}"]`,
      ) ?? [],
    ) as unknown as XULElement[];

    if (!workspaceTabs?.length) {
      try {
        const tab = this.createTabForWorkspace(workspaceId);
        this.moveTabToWorkspace(workspaceId, tab);
        globalThis.gBrowser.selectedTab = tab;
      } catch (e) {
        console.error("Failed to create tab for workspace:", e);
        const defaultWorkspaceId = this.dataManagerCtx.getDefaultWorkspaceID();
        if (defaultWorkspaceId !== workspaceId) {
          this.changeWorkspace(defaultWorkspaceId);
        }
      }
    } else {
      globalThis.gBrowser.selectedTab = workspaceTabs[0];
    }
  }

  /**
   * Check if workspace has tabs.
   * @param workspaceId The workspace id.
   * @returns true if workspace has tabs.
   */
  public workspaceHasTabs(workspaceId: string) {
    const workspaceTabs = Array.from(
      document?.querySelectorAll(
        `[${WORKSPACE_TAB_ATTRIBUTION_ID}="${workspaceId}"]`,
      ) ?? [],
    ) as unknown as XULElement[];
    return workspaceTabs?.length > 0 ? workspaceTabs[0] : false;
  }

  /**
   * Check if there is no workspace tabs.
   * @returns true if there is no workspace tabs if false, return tab.
   */
  public isThereNoWorkspaceTabs() {
    for (
      const tab of globalThis.gBrowser.tabs as Array<
        XULElement | undefined | null
      >
    ) {
      if (!tab) continue;
      if (!tab.hasAttribute(WORKSPACE_TAB_ATTRIBUTION_ID)) {
        return tab;
      }
    }
    return true;
  }

  /**
   * Move tabs to workspace.
   * @param workspaceId The workspace id.
   */
  moveTabToWorkspace(workspaceId: TWorkspaceID, tab: XULElement) {
    const oldWorkspaceId = this.getWorkspaceIdFromAttribute(tab);
    this.setWorkspaceIdToAttribute(tab, workspaceId);

    if (tab === globalThis.gBrowser.selectedTab && oldWorkspaceId) {
      const oldWorkspaceTabs = Array.from(
        document?.querySelectorAll(
          `[${WORKSPACE_TAB_ATTRIBUTION_ID}="${oldWorkspaceId}"]`,
        ) ?? [],
      ) as unknown as XULElement[];

      if (oldWorkspaceTabs && oldWorkspaceTabs.length > 0) {
        this.switchToAnotherWorkspaceTab(oldWorkspaceId);
      } else {
        const defaultWorkspaceId = this.dataManagerCtx.getDefaultWorkspaceID();
        this.changeWorkspace(defaultWorkspaceId);
      }
    }
  }

  /**
   * Move tabs to workspace from tab context menu.
   * @param workspaceId The workspace id.
   */
  public moveTabsToWorkspaceFromTabContextMenu(workspaceId: TWorkspaceID) {
    const reopenedTabs = globalThis.TabContextMenu.contextTab.multiselected
      ? globalThis.gBrowser.selectedTabs
      : [globalThis.TabContextMenu.contextTab];

    for (const tab of reopenedTabs) {
      this.moveTabToWorkspace(workspaceId, tab);
      if (tab === globalThis.gBrowser.selectedTab) {
        this.switchToAnotherWorkspaceTab(workspaceId);
      }
    }
    this.updateTabsVisibility();
  }

  /**
   * Returns target toolbar item.
   * @returns The target toolbar item.
   */
  private get targetToolbarItem(): XULElement | undefined | null {
    return document?.querySelector("#workspaces-toolbar-button") as
      | XULElement
      | null
      | undefined;
  }

  /**
   * Returns panel UI target element.
   * @returns The panel UI target element.
   */
  private get panelUITargetElement():
    | PanelMultiViewParentElement
    | undefined
    | null {
    return document?.querySelector("#customizationui-widget-panel") as
      | PanelMultiViewParentElement
      | null
      | undefined;
  }

  private getMaybeSelectedWorkspacebyVisibleTabs(): TWorkspaceID | null {
    const tabs = (globalThis.gBrowser.visibleTabs as XULElement[]).slice(0, 10);
    const workspaceIdCounts = new Map<TWorkspaceID, number>();

    for (const tab of tabs) {
      const workspaceId = this.getWorkspaceIdFromAttribute(tab);
      if (workspaceId) {
        workspaceIdCounts.set(
          workspaceId,
          (workspaceIdCounts.get(workspaceId) || 0) + 1,
        );
      }
    }

    let mostFrequentId: TWorkspaceID | null = null;
    let maxCount = 0;

    workspaceIdCounts.forEach((count, id) => {
      if (count > maxCount) {
        maxCount = count;
        mostFrequentId = id;
      }
    });

    return mostFrequentId;
  }
}
