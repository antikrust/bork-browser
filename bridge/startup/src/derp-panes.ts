/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * derp settings panes — registry. One module per pane under panes/, all
 * injected into about:preferences as native categories (see
 * panes/framework.ts for the machinery). This is the pane-by-pane
 * retirement of the separate React settings app (about:hub).
 */

import { registerWorkspacesPane } from "./panes/workspaces.ts";
import { registerDesignPane } from "./panes/design.ts";
import { registerSidebarPane } from "./panes/sidebar.ts";
import { registerGesturePane } from "./panes/gesture.ts";
import { registerShortcutsPane } from "./panes/shortcuts.ts";
import { applyDerpReskin } from "./panes/reskin.ts";

export function setupDerpPanes(): void {
  applyDerpReskin();
  trimNativeSettings();
  // Order = sidebar order: Appearance first (most used), then features.
  registerDesignPane();
  registerWorkspacesPane();
  registerSidebarPane();
  registerGesturePane();
  registerShortcutsPane();
}

/**
 * Remove native settings surfaces for features derp doesn't ship. The CSS in
 * reskin.ts hides the lazy-rendered pane content; removing the category
 * button here keeps it out of keyboard navigation too. The pane content's
 * data-category is read off the button before removal so the hide rule can't
 * drift from Firefox's internal naming.
 */
function trimNativeSettings(): void {
  try {
    const doc = document!;
    const ai = doc.getElementById("category-ai-features");
    const view = ai?.getAttribute("view");
    if (view) {
      const style = doc.createElement("style");
      style.textContent =
        `[data-category="${view}"], setting-pane[data-category="${view}"] { display: none !important; }`;
      doc.head?.appendChild(style);
    }
    ai?.remove();
  } catch (e) {
    console.error("[derp-panes] trimNativeSettings failed:", e);
  }
}
