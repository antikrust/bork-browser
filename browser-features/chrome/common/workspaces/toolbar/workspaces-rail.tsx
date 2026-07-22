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
import { workspaceColorCss } from "../utils/workspace-colors.ts";
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
// While this is set the rail is on its way out: the slot stays owned (the
// native launcher stays hidden) and the CSS collapses the slot's width so
// the exit eases instead of snapping. Removed when the teardown completes.
const RAIL_CLOSING_ATTR = "derp-rail-closing";
const RAIL_EASE_MS = 200;
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
};

const getTranslations = () => ({
  createNew: i18next.t(translationKeys.createNew),
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
  // Workspace colour tints the glyph via inline stroke (the data-URI
  // glyphs paint context-stroke); unset stays on the stylesheet's
  // currentColor.
  const iconStroke = createMemo(() =>
    workspaceColorCss(
      (workspace() as { color?: string | null } | undefined)?.color,
    )
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

    // The trigger event makes the popup manager set popup.triggerNode —
    // the shared menu's primary way to resolve which workspace was hit.
    menu?.openPopupAtScreen(event.screenX, event.screenY, true, event);
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
      // HTML element: tooltips come from title. tooltiptext is XUL-only
      // and silently does nothing here (the round of "quicker tooltips"
      // that swapped it in killed rail tooltips entirely).
      title={workspaceName()}
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
      <img
        src={iconUrl()}
        width="16"
        height="16"
        alt=""
        style={iconStroke() ? { stroke: iconStroke()! } : undefined}
      />
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

function Rail(props: { ctx: WorkspacesService; present: () => boolean }) {
  const [texts, setTexts] = createSignal(getTranslations());

  addI18nObserver(() => {
    setTexts(getTranslations());
  });

  // createNoNameWorkspace already switches to the new workspace itself.
  const handleCreateWorkspace = () => props.ctx.createNoNameWorkspace();

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
    <Show when={props.present()}>
      <div id="derp-workspaces-rail">
        <div class="derp-workspaces-rail-list">
          <For each={railOrder()}>
            {(workspaceId) => (
              <RailWorkspaceButton workspaceId={workspaceId} ctx={props.ctx} />
            )}
          </For>
        </div>
        {/* Import lives in the welcome flow (pages-welcome import step),
            not on the rail — install-time concern, not a daily control. */}
        <div class="derp-workspaces-rail-footer">
          <RailControlButton
            id="derp-workspaces-rail-create"
            icon="chrome://global/skin/icons/plus.svg"
            label={texts().createNew}
            onActivate={handleCreateWorkspace}
          />
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

    // `present` keeps the rail mounted through its exit animation: it goes
    // true immediately on show, but lags railActive going false by
    // RAIL_EASE_MS so the slot can collapse smoothly before teardown.
    const [present, setPresent] = createSignal(railActive());
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    render(() => <Rail ctx={ctx} present={present} />, host, {
      hotCtx: import.meta.hot,
    });

    // Depends only on railActive() — setPresent is never read here, so no
    // reactive loop.
    createEffect(() => {
      if (railActive()) {
        if (closeTimer) {
          clearTimeout(closeTimer);
          closeTimer = undefined;
        }
        root.removeAttribute(RAIL_CLOSING_ATTR);
        setPresent(true);
        this.activate(root);
      } else {
        // Ease out: hold the slot (RAIL_ACTIVE_ATTR stays, native launcher
        // stays hidden) and mark it closing so the CSS collapses the slot
        // width; tear down only once the animation has run.
        root.setAttribute(RAIL_CLOSING_ATTR, "");
        if (closeTimer) clearTimeout(closeTimer);
        closeTimer = setTimeout(() => {
          closeTimer = undefined;
          root.removeAttribute(RAIL_CLOSING_ATTR);
          setPresent(false);
          this.deactivate(root);
        }, RAIL_EASE_MS);
      }
    });

    onCleanup(() => {
      if (closeTimer) clearTimeout(closeTimer);
      root.removeAttribute(RAIL_CLOSING_ATTR);
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
