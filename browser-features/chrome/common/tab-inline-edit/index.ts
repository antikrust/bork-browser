/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { noraComponent, NoraComponentBase } from "#features-chrome/utils/base";

/**
 * Inline address edit on row-1 tabs: double-click a tab and it eases out
 * to a wide cell with a text input over it; Enter navigates that tab,
 * Escape or clicking away eases it back. The row-2 stack cells have
 * their own copy of this behaviour in stack-bar.tsx.
 */

const EDIT_ATTR = "derp-editing";
// Width transitions live on a separate attribute that outlasts the edit,
// so the ease-back animates; a blanket transition on all tabs would
// fight the native open/close animations.
const ANIM_ATTR = "derp-edit-anim";

type BrowserLike = {
  currentURI?: { spec?: string };
  fixupAndLoadURIString?: (url: string, opts: Record<string, unknown>) => void;
};

type TabLike = XULElement & {
  linkedBrowser?: BrowserLike | null;
};

type GB = {
  selectedTab: TabLike;
  getBrowserForTab?: (tab: TabLike) => BrowserLike | null;
};

@noraComponent(import.meta.hot)
export default class TabInlineEdit extends NoraComponentBase {
  init(): void {
    const doc = document;
    if (!doc) {
      console.error("[tab-inline-edit] no document at init");
      return;
    }

    let activeInput: HTMLInputElement | null = null;
    let activeTab: TabLike | null = null;

    const closeEdit = () => {
      const tab = activeTab;
      activeInput?.remove();
      activeInput = null;
      activeTab = null;
      if (tab) {
        tab.removeAttribute(EDIT_ATTR);
        // Keep the transition rule alive through the ease-back.
        setTimeout(() => tab.removeAttribute(ANIM_ATTR), 220);
      }
    };

    const commit = (value: string) => {
      const tab = activeTab;
      closeEdit();
      const url = value.trim();
      if (!url || !tab) return;
      try {
        const uri = Services.uriFixup.getFixupURIInfo(
          url,
          Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP |
            Ci.nsIURIFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS,
        ).preferredURI;
        if (!uri) return;
        // Typed input must never run script or spoof a document.
        if (uri.schemeIs("javascript") || uri.schemeIs("data")) return;
        const gb = (globalThis as unknown as { gBrowser?: GB }).gBrowser;
        // Lazy tabs have no browser yet; getBrowserForTab instantiates.
        const browser = tab.linkedBrowser ??
          gb?.getBrowserForTab?.(tab) ?? null;
        browser?.fixupAndLoadURIString?.(uri.spec, {
          triggeringPrincipal: Services.scriptSecurityManager
            .getSystemPrincipal(),
        });
      } catch (e) {
        console.error("[tab-inline-edit] load failed:", e);
      }
    };

    const startEdit = (tab: TabLike) => {
      closeEdit();
      // The input is an OVERLAY above the strip, anchored at the tab and
      // easing from tab width to full width. Widening the tab itself is
      // a lost cause: tab min/max-width are pinned by user/agent-origin
      // rules (lepton, Floorp design) that outrank any author CSS.
      const strip = doc.getElementById("TabsToolbar");
      if (!strip) return;
      const tabRect = (tab as unknown as Element).getBoundingClientRect();
      const stripRect = strip.getBoundingClientRect();
      activeTab = tab;
      tab.setAttribute(ANIM_ATTR, "true");
      tab.setAttribute(EDIT_ATTR, "true");
      const input = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "input",
      ) as HTMLInputElement;
      input.className = "derp-tab-url-input";
      input.style.left = `${Math.round(tabRect.x - stripRect.x)}px`;
      input.style.top = `${Math.round(tabRect.y - stripRect.y) + 1}px`;
      input.style.height = `${Math.round(tabRect.height)}px`;
      input.style.width = `${Math.round(tabRect.width)}px`;
      let current = "";
      try {
        const spec = tab.linkedBrowser?.currentURI?.spec ?? "";
        current = spec === "about:newtab" || spec === "about:blank"
          ? ""
          : spec;
      } catch {
        current = "";
      }
      input.value = current;
      input.placeholder = "Enter address";
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          commit(input.value);
        } else if (e.key === "Escape") {
          closeEdit();
        }
        // The strip's own key handling must not see this typing.
        e.stopPropagation();
      });
      input.addEventListener("blur", () => closeEdit());
      // Tabs select on mousedown; typing-related clicks stay ours.
      input.addEventListener("mousedown", (e: Event) => e.stopPropagation());
      input.addEventListener("click", (e: Event) => e.stopPropagation());
      input.addEventListener("dblclick", (e: Event) => e.stopPropagation());
      strip.appendChild(input);
      activeInput = input;
      // A beat after insertion: ease out to full width (the transition
      // rides the width change). A timer, not requestAnimationFrame —
      // rAF only fires on refresh-driver ticks. Re-measure the tab here:
      // selecting it may have scrolled the strip since the first measure.
      setTimeout(() => {
        if (activeInput !== input || !tab.isConnected) return;
        const tr = (tab as unknown as Element).getBoundingClientRect();
        const sr = strip.getBoundingClientRect();
        const full = Math.min(340, Math.round(sr.width) - 16);
        // Anchor at the tab, but slide leftward when the tab sits too
        // close to the strip's end for the full width to fit.
        const left = Math.max(
          4,
          Math.min(
            Math.round(tr.x - sr.x),
            Math.round(sr.width) - full - 8,
          ),
        );
        input.style.left = `${left}px`;
        input.style.top = `${Math.round(tr.y - sr.y) + 1}px`;
        input.style.width = `${full}px`;
        input.focus();
        input.select();
      }, 30);
    };

    const onDblClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target || target.closest?.(".derp-tab-url-input")) return;
      const tab = target.closest?.(
        "#tabbrowser-tabs .tabbrowser-tab:not([pinned])",
      ) as TabLike | null;
      if (!tab) return;
      // Capture phase: pre-empt native strip double-click behaviour
      // (close-by-dblclick pref, dblclick-on-strip new tab).
      event.preventDefault();
      event.stopPropagation();
      startEdit(tab);
    };
    doc.addEventListener("dblclick", onDblClick, true);
  }
}
