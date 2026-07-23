/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * bork settings panes — registry. One module per pane under panes/, all
 * injected into about:preferences as native categories (see
 * panes/framework.ts for the machinery). This is the pane-by-pane
 * retirement of the separate React settings app (about:hub).
 */

import { registerWorkspacesPane } from "./panes/workspaces.ts";
import { registerDesignPane } from "./panes/design.ts";
import { registerSidebarPane } from "./panes/sidebar.ts";
import { registerGesturePane } from "./panes/gesture.ts";
import { registerShortcutsPane } from "./panes/shortcuts.ts";
import { applyBorkReskin } from "./panes/reskin.ts";

export function setupBorkPanes(): void {
  applyBorkReskin();
  // Order = sidebar order: Appearance first (most used), then features.
  registerDesignPane();
  registerWorkspacesPane();
  registerSidebarPane();
  registerGesturePane();
  registerShortcutsPane();
}
