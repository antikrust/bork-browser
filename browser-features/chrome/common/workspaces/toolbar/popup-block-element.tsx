/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { TWorkspaceID } from "../utils/type.js";
import type { WorkspacesService } from "../workspacesService";
import { getContainerColorName } from "../utils/container-color";
import { workspacesDataStore } from "../data/data.ts";
import { WORKSPACE_TAB_ATTRIBUTION_ID } from "../utils/workspaces-static-names.ts";
import { LAYERS_ICON } from "./icons.ts";

// A drop/drag-end can be followed by a stray click on the same row, which
// would switch workspace and slam the popup shut mid-reorder.
let suppressClickUntil = 0;

/**
 * Rows register their inline-rename starter here so the context menu's
 * "Rename Workspace" opens the very same editor double-click does — one
 * implementation, two entry points.
 */
const renameStarters = new Map<string, () => void>();

export function startInlineRename(workspaceId: string): boolean {
  const start = renameStarters.get(workspaceId);
  if (!start) return false;
  start();
  return true;
}

export function PopupToolbarElement(props: {
  workspaceId: TWorkspaceID;
  isSelected: boolean;
  bmsMode: boolean;
  ctx: WorkspacesService;
  refreshTick?: () => number;
  formatTabCount?: (count: number) => string;
  /** Pinned rows (the default workspace) neither drag nor accept drops. */
  pinned?: boolean;
}) {
  const workspace = createMemo(() =>
    props.ctx.getRawWorkspace(props.workspaceId)
  );

  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");

  const startEditing = () => {
    const current = workspace();
    if (!current) return;
    setDraft(current.name);
    setEditing(true);
    // Focus once Solid has swapped the row text for the input. Looked up by
    // id because the solid-xul universal renderer doesn't provide the `use`
    // helper that the JSX `ref` attribute compiles into.
    setTimeout(() => {
      const input = document?.getElementById(
        `workspaceRenameInput-${props.workspaceId}`,
      ) as HTMLInputElement | null;
      input?.focus();
      input?.select();
    }, 0);
  };

  renameStarters.set(props.workspaceId, () => startEditing());
  onCleanup(() => renameStarters.delete(props.workspaceId));

  const commitEditing = () => {
    if (!editing()) return;
    props.ctx.renameWorkspace(props.workspaceId, draft());
    setEditing(false);
  };

  /** Live tab count; recomputed whenever the popup is (re)shown. */
  const tabCount = createMemo(() => {
    props.refreshTick?.();
    try {
      const win = globalThis as unknown as {
        gBrowser?: { tabs: ArrayLike<Element> };
      };
      const tabs = win.gBrowser?.tabs;
      if (!tabs) return 0;
      let count = 0;
      for (const tab of Array.from(tabs)) {
        if (
          tab.getAttribute(WORKSPACE_TAB_ATTRIBUTION_ID) === props.workspaceId
        ) {
          count++;
        }
      }
      return count;
    } catch {
      return 0;
    }
  });

  const tabCountLabel = () =>
    props.formatTabCount
      ? props.formatTabCount(tabCount())
      : `${tabCount()} tabs`;

  const handleDragStart = (event: DragEvent) => {
    if (props.pinned) {
      event.preventDefault();
      return;
    }
    try {
      const target = event.currentTarget as XULElement;
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        // Private type: only our drop targets understand it, so dropping a
        // workspace on the tab strip / urlbar can't paste a UUID anywhere.
        event.dataTransfer.setData(
          "application/x-derp-workspace",
          props.workspaceId,
        );
        // HTML ghost node (snapshotting the live XUL row inside a native
        // panel is flaky), anchored exactly at the grab point so it never
        // hangs off the window edge.
        const ws = workspace();
        const ghost = document!.createElement("div");
        ghost.className = "workspaceDragGhost";
        ghost.textContent = ws?.name ?? "";
        document!.documentElement?.appendChild(ghost);
        const rect = (target as unknown as Element).getBoundingClientRect();
        event.dataTransfer.setDragImage(
          ghost,
          Math.max(0, event.clientX - rect.left),
          Math.max(0, event.clientY - rect.top),
        );
        setTimeout(() => ghost.remove(), 0);
        target.setAttribute("dragging", "true");
      }
    } catch (e) {
      console.error("[workspaces] dragstart failed:", e);
    }
  };

  const handleDragEnd = (event: DragEvent) => {
    const target = event.currentTarget as XULElement;
    target.removeAttribute("dragging");
    suppressClickUntil = Date.now() + 250;
  };

  const handleDragOver = (event: DragEvent) => {
    if (props.pinned) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    // Insertion-point affordance, not a drop-onto highlight: the line renders
    // above or below this row depending on which half the pointer is in,
    // showing where the dragged workspace will land.
    const target = event.currentTarget as XULElement;
    const rect = target.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    target.setAttribute("drag-over", before ? "before" : "after");
  };

  const handleDragLeave = (event: DragEvent) => {
    const target = event.currentTarget as XULElement;
    target.removeAttribute("drag-over");
  };

  const handleDrop = (event: DragEvent) => {
    if (props.pinned) return;
    event.preventDefault();
    const target = event.currentTarget as XULElement;
    target.removeAttribute("drag-over");

    if (!event.dataTransfer) {
      return;
    }

    suppressClickUntil = Date.now() + 250;

    const draggedWorkspaceId = event.dataTransfer.getData(
      "application/x-derp-workspace",
    ) as TWorkspaceID | "";
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

    // Insert before or after this row, matching the line the user saw.
    // reorderWorkspaceTo splices after removal, so when the dragged item sat
    // above the insertion point the index shifts down by one.
    const rect = (event.currentTarget as XULElement).getBoundingClientRect();
    const after = event.clientY >= rect.top + rect.height / 2;
    const draggedIndex = order.indexOf(draggedWorkspaceId);
    let insertion = targetIndex + (after ? 1 : 0);
    if (draggedIndex !== -1 && draggedIndex < insertion) insertion -= 1;

    props.ctx.reorderWorkspaceTo(draggedWorkspaceId, insertion);
  };

  return (
    <Show when={workspace()}>
      {(ws) => {
        // The pinned default row carries the same layers glyph as the
        // chooser button — one identity for "Workspaces" everywhere.
        const icon = () =>
          props.pinned
            ? LAYERS_ICON
            : props.ctx.iconCtx.getWorkspaceIconUrl(ws().icon);
        const userContextId = () => ws().userContextId ?? 0;
        const hasContainer = () => userContextId() > 0;
        const containerColorName = () => getContainerColorName(userContextId());
        return (
          <xul:hbox
            id={`workspace-${props.workspaceId}`}
            class="workspaceRow"
            align="center"
            context="workspaces-toolbar-item-context-menu"
            data-selected={props.isSelected ? "true" : "false"}
            data-workspaceId={props.workspaceId}
            data-has-container={hasContainer() ? "true" : "false"}
            data-container-color={containerColorName() ?? ""}
            draggable={props.pinned ? "false" : "true"}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={(event: MouseEvent) => {
              if (editing()) return;
              if (Date.now() < suppressClickUntil) return;
              props.ctx.changeWorkspace(props.workspaceId);
              // Vivaldi behavior: choosing a workspace dismisses the menu.
              const panel = (event.currentTarget as Element).closest(
                "panel",
              ) as (Element & { hidePopup?: () => void }) | null;
              panel?.hidePopup?.();
            }}
            onDblClick={startEditing}
          >
            <xul:image class="workspaceRowIcon" src={icon()} />
            <Show
              when={!editing()}
              fallback={
                <input
                  id={`workspaceRenameInput-${props.workspaceId}`}
                  class="workspaceRenameInput"
                  value={draft()}
                  onInput={(e) => setDraft(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      commitEditing();
                    } else if (e.key === "Escape") {
                      setEditing(false);
                    }
                    // Keep panel-level key handling (e.g. Escape closing the
                    // whole popup) out of the edit session.
                    e.stopPropagation();
                  }}
                  onBlur={commitEditing}
                />
              }
            >
              <xul:vbox class="workspaceRowText" flex="1">
                <xul:label class="workspaceRowName">{ws().name}</xul:label>
                <xul:label class="workspaceRowCount">
                  {tabCountLabel()}
                </xul:label>
              </xul:vbox>
            </Show>
            <Show
              when={props.isSelected}
              fallback={props.pinned ? undefined : (
                <xul:label class="workspaceRowHandle">≡</xul:label>
              )}
            >
              <xul:label class="workspaceRowCheck">✓</xul:label>
            </Show>
          </xul:hbox>
        );
      }}
    </Show>
  );
}
