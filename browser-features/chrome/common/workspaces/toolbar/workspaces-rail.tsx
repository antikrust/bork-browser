/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { render } from "@nora/solid-xul";
import type { WorkspacesService } from "../workspacesService.ts";
import { configStore, enabled } from "../data/config.ts";
import { selectedWorkspaceID, workspacesDataStore } from "../data/data.ts";
import type { TWorkspaceID } from "../utils/type.ts";
import { addI18nObserver } from "#i18n/config-browser-chrome.ts";
import i18next from "i18next";
import {
  hasVivaldiWorkspaces,
  importVivaldiWorkspaces,
} from "../vivaldi-import.ts";
import { LAYERS_ICON } from "./icons.ts";

/**
 * Vivaldi-style workspaces rail, living in Firefox's revamped-sidebar slot
 * (the #sidebar-main box from browser.xhtml, the one the slim icon
 * launcher occupies when sidebar.revamp is on).
 *
 * Firefox keeps ownership of the slot — geometry, position, show/hide all
 * stay SidebarController's — while we own its *content*: the native lit
 * <sidebar-main> launcher (a MozLitElement that re-renders itself; never
 * inject into it) is CSS-hidden behind the derp-workspaces-rail root
 * attribute, and our SolidJS rail renders as its sibling inside the box.
 *
 * Visibility follows configStore.manageOnBms. Turning the rail on ensures
 * sidebar.revamp is true, remembering in RAIL_ENABLED_REVAMP_PREF whether
 * WE flipped it so turning the rail off restores false only in that case.
 */

const REVAMP_PREF = "sidebar.revamp";
const RAIL_ENABLED_REVAMP_PREF = "derp.workspaces.rail.enabledRevamp";
const RAIL_ACTIVE_ATTR = "derp-workspaces-rail";
const HOST_BOX_ID = "sidebar-main";

const DEFAULT_ICON = "chrome://branding/content/icon32.png";
const CONTEXT_MENU_ID = "workspaces-toolbar-item-context-menu";

type ChromeDocument = Document & { popupNode?: Element | null };

type SidebarStateLike = { launcherVisible: boolean };
type SidebarControllerLike = {
  promiseInitialized?: Promise<void>;
  waitUntilStable?: () => Promise<void>;
  enabledViaSettings?: (isEnabled?: boolean) => void;
  _state?: SidebarStateLike;
};

const getSidebarController = (): SidebarControllerLike | null =>
  (globalThis as unknown as { SidebarController?: SidebarControllerLike })
    .SidebarController ?? null;

const railActive = (): boolean =>
  enabled() && Boolean(configStore.manageOnBms);

const translationKeys = {
  createNew: "workspaces.popup.create-new" as const,
  importVivaldi: "workspaces.popup.import-vivaldi" as const,
};

const getTranslations = () => ({
  createNew: i18next.t(translationKeys.createNew),
  importVivaldi: i18next.t(translationKeys.importVivaldi),
});

type RailWorkspaceButtonProps = {
  workspaceId: TWorkspaceID;
  ctx: WorkspacesService;
};

/**
 * Icon-only workspace button. Same semantics as the old panel-sidebar
 * buttons: tooltip carries the full name, click switches workspace, right
 * click opens the shared workspaces context menu, and drag reorders with
 * the before/after insertion-line affordance (carried by the existing
 * .workspace-panel[drag-over] styles).
 */
const RailWorkspaceButton = (props: RailWorkspaceButtonProps) => {
  const workspace = createMemo(() => {
    const data = workspacesDataStore.data;
    if (data instanceof Map) {
      return data.get(props.workspaceId);
    }
    return undefined;
  });
  const isDefaultWorkspace = createMemo(() =>
    workspacesDataStore.defaultID === props.workspaceId
  );
  const iconUrl = createMemo(() =>
    // The default workspace always wears the layers glyph — the same
    // identity the chooser button shows — no matter what icon its data
    // carries (legacy profiles stored the old coloured builtins there).
    isDefaultWorkspace() ? LAYERS_ICON : props.ctx.iconCtx.getWorkspaceIconUrl(
      (workspace() as { icon?: string } | undefined)?.icon,
    ) ?? DEFAULT_ICON
  );
  const workspaceName = createMemo(() =>
    (workspace() as { name?: string } | undefined)?.name ?? ""
  );
  const isSelected = () => selectedWorkspaceID() === props.workspaceId;

  const handleActivate = () => {
    if (!isSelected()) {
      props.ctx.changeWorkspace(props.workspaceId);
    }
  };

  const handleContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const target = event.currentTarget as XULElement;
    (document as ChromeDocument).popupNode = target;

    const menu = document?.getElementById(CONTEXT_MENU_ID) as
      | XULPopupElement
      | null;

    menu?.openPopupAtScreen(event.screenX, event.screenY, true);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleActivate();
    }
  };

  const handleDragStart = (event: DragEvent) => {
    const target = event.currentTarget as HTMLElement;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", props.workspaceId);
      target.setAttribute("dragging", "true");
    }
  };

  const handleDragEnd = (event: DragEvent) => {
    const target = event.currentTarget as HTMLElement;
    target.removeAttribute("dragging");
  };

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    // Insertion-point affordance, not a drop-onto highlight (see
    // popup-block-element.tsx — same treatment in the popup list).
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    target.setAttribute("drag-over", before ? "before" : "after");
  };

  const handleDragLeave = (event: DragEvent) => {
    const target = event.currentTarget as HTMLElement;
    target.removeAttribute("drag-over");
  };

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.removeAttribute("drag-over");

    if (!event.dataTransfer) {
      return;
    }

    const draggedWorkspaceId = event.dataTransfer.getData("text/plain") as
      | TWorkspaceID
      | "";
    if (!draggedWorkspaceId || draggedWorkspaceId === props.workspaceId) {
      return;
    }

    if (!props.ctx.isWorkspaceID(draggedWorkspaceId)) {
      return;
    }

    const order = workspacesDataStore.order;
    const targetIndex = order.indexOf(props.workspaceId);
    if (targetIndex === -1) {
      return;
    }

    // Insert before/after to match the indicator line (see
    // popup-block-element.tsx for the index math).
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const after = event.clientY >= rect.top + rect.height / 2;
    const draggedIndex = order.indexOf(draggedWorkspaceId);
    let insertion = targetIndex + (after ? 1 : 0);
    if (draggedIndex !== -1 && draggedIndex < insertion) insertion -= 1;

    props.ctx.reorderWorkspaceTo(draggedWorkspaceId, insertion);
  };

  // Buttons are direct siblings (no wrapper) with the camel-case
  // data-workspaceId attribute: the shared context menu walks
  // previous/nextElementSibling and reads exactly that attribute to
  // decide the move up/down disabled states.
  return (
    <div
      id={`workspace-${props.workspaceId}`}
      class="workspace-panel workspace-rail-button"
      data-checked={isSelected() ? "true" : undefined}
      data-workspaceId={props.workspaceId}
      role="button"
      tabIndex={0}
      tooltiptext={workspaceName()}
      aria-label={workspaceName()}
      draggable={isDefaultWorkspace() ? "false" : "true"}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      onDragStart={isDefaultWorkspace() ? undefined : handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={isDefaultWorkspace() ? undefined : handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={isDefaultWorkspace() ? undefined : handleDrop}
    >
      <img src={iconUrl()} width="16" height="16" alt="" />
    </div>
  );
};

type RailControlButtonProps = {
  id: string;
  icon: string;
  label: string;
  onActivate: () => void;
};

const RailControlButton = (props: RailControlButtonProps) => {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      props.onActivate();
    }
  };

  return (
    <div
      id={props.id}
      class="workspace-rail-button workspace-rail-control"
      role="button"
      tabIndex={0}
      title={props.label}
      aria-label={props.label}
      onClick={props.onActivate}
      onKeyDown={handleKeyDown}
    >
      <img src={props.icon} width="16" height="16" alt="" />
    </div>
  );
};

function Rail(props: { ctx: WorkspacesService }) {
  const [texts, setTexts] = createSignal(getTranslations());

  addI18nObserver(() => {
    setTexts(getTranslations());
  });

  // createNoNameWorkspace already switches to the new workspace itself.
  const handleCreateWorkspace = () => props.ctx.createNoNameWorkspace();

  // Only offer the import when there is actually a Vivaldi profile to read.
  const [canImportVivaldi, setCanImportVivaldi] = createSignal(false);
  createEffect(() => {
    if (!railActive()) return;
    hasVivaldiWorkspaces()
      .then(setCanImportVivaldi)
      .catch(() => setCanImportVivaldi(false));
  });

  const handleImportVivaldi = () => {
    importVivaldiWorkspaces(props.ctx)
      .then((result) => {
        console.log(
          `[workspaces] Imported ${result.workspacesCreated} Vivaldi workspaces, ${result.tabsRestored} tabs` +
            (result.skipped.length
              ? ` (already present: ${result.skipped.join(", ")})`
              : ""),
        );
        // Nothing new to offer once everything has come across.
        setCanImportVivaldi(false);
      })
      .catch((e) => console.error("[workspaces] Vivaldi import failed", e));
  };

  // Mirror the chooser popup exactly: the default workspace pinned on
  // top, then the reorderable rest in store order. The rail used to show
  // raw store order, so the default sat wherever history left it.
  const railOrder = createMemo(() => {
    const def = workspacesDataStore.defaultID;
    const rest = workspacesDataStore.order.filter((id) => id !== def);
    return def && workspacesDataStore.order.includes(def)
      ? [def, ...rest]
      : [...workspacesDataStore.order];
  });

  return (
    <Show when={railActive()}>
      <div id="derp-workspaces-rail">
        <div class="derp-workspaces-rail-list">
          <For each={railOrder()}>
            {(workspaceId) => (
              <RailWorkspaceButton workspaceId={workspaceId} ctx={props.ctx} />
            )}
          </For>
        </div>
        <div class="derp-workspaces-rail-footer">
          <RailControlButton
            id="derp-workspaces-rail-create"
            icon="chrome://global/skin/icons/plus.svg"
            label={texts().createNew}
            onActivate={handleCreateWorkspace}
          />
          <Show when={canImportVivaldi()}>
            <RailControlButton
              id="derp-workspaces-rail-import-vivaldi"
              icon="chrome://browser/skin/import.svg"
              label={texts().importVivaldi}
              onActivate={handleImportVivaldi}
            />
          </Show>
        </div>
      </div>
    </Show>
  );
}

export class WorkspacesSidebarRail {
  constructor(ctx: WorkspacesService) {
    const root = document?.documentElement;
    const host = document?.getElementById(HOST_BOX_ID);
    if (!root || !host) {
      return;
    }

    // Main browser windows only: popup windows (chromehidden set) hide the
    // launcher slot themselves and must not flip global prefs.
    if (
      root.getAttribute("windowtype") !== "navigator:browser" ||
      (root.getAttribute("chromehidden") ?? "") !== ""
    ) {
      return;
    }

    render(() => <Rail ctx={ctx} />, host, { hotCtx: import.meta.hot });

    createEffect(() => {
      if (railActive()) {
        this.activate(root);
      } else {
        this.deactivate(root);
      }
    });

    onCleanup(() => {
      root.removeAttribute(RAIL_ACTIVE_ATTR);
    });
  }

  private activate(root: Element): void {
    try {
      if (!Services.prefs.getBoolPref(REVAMP_PREF, false)) {
        // The revamp launcher defaults to hidden on FF152
        // (DEFAULT_LAUNCHER_VISIBLE is false); announce the flip the way
        // about:preferences does so the re-init shows the slot.
        try {
          getSidebarController()?.enabledViaSettings?.(true);
        } catch {
          // best effort — ensureLauncherVisible() below is the backstop
        }
        Services.prefs.setBoolPref(REVAMP_PREF, true);
        Services.prefs.setBoolPref(RAIL_ENABLED_REVAMP_PREF, true);
      }
    } catch (e) {
      console.error("[workspaces] rail: enabling sidebar.revamp failed:", e);
    }
    root.setAttribute(RAIL_ACTIVE_ATTR, "");
    void this.ensureLauncherVisible();
  }

  private deactivate(root: Element): void {
    root.removeAttribute(RAIL_ACTIVE_ATTR);
    try {
      if (Services.prefs.getBoolPref(RAIL_ENABLED_REVAMP_PREF, false)) {
        // Marker first: every window runs this on the config flip and only
        // the first should touch sidebar.revamp.
        Services.prefs.clearUserPref(RAIL_ENABLED_REVAMP_PREF);
        Services.prefs.clearUserPref(REVAMP_PREF);
      }
    } catch (e) {
      console.error("[workspaces] rail: restoring sidebar.revamp failed:", e);
    }
  }

  /**
   * Showing the slot stays SidebarController's job — we only assert
   * "launcher visible" through its own state setter. Retried on a short
   * schedule because a runtime sidebar.revamp flip re-initializes the
   * controller asynchronously and can overwrite an early assertion.
   */
  private async ensureLauncherVisible(): Promise<void> {
    const controller = getSidebarController();
    if (!controller) {
      return;
    }
    try {
      await controller.promiseInitialized;
      await controller.waitUntilStable?.();
    } catch (e) {
      console.error(
        "[workspaces] rail: waiting for SidebarController failed:",
        e,
      );
    }
    const host = document?.getElementById(HOST_BOX_ID) as
      | (Element & { hidden?: boolean })
      | null;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!railActive()) {
        return;
      }
      try {
        const state = getSidebarController()?._state;
        if (state) {
          state.launcherVisible = true;
        }
      } catch (e) {
        console.error("[workspaces] rail: showing launcher failed:", e);
        return;
      }
      if (host && host.hidden === false) {
        return;
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, 200));
    }
  }
}
