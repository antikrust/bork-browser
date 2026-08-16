/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { render } from "@nora/solid-xul";
import { createRoot, getOwner, type Owner, runWithOwner } from "solid-js";
import { ChromeSiteBrowser } from "../browsers/chrome-site-browser.tsx";
import { ExtensionSiteBrowser } from "../browsers/extension-site-browser.tsx";
import {
  panelSidebarConfig,
  panelSidebarData,
  selectedPanelId,
  setPanelSidebarData,
  setSelectedPanelId,
} from "../data/data.ts";
import type { Panel } from "../utils/type.ts";
import { createEffect } from "solid-js";
import { getExtensionSidebarAction } from "../extension-panels.ts";
import { WebsitePanel } from "../website-panel-window-parent.ts";
import "../utils/webRequest.ts";

export class CPanelSidebar {
  private panelDisposers: Map<string, () => void> = new Map();
  private get parentElement() {
    return document?.getElementById("panel-sidebar-browser-box") as unknown as
      | XULElement
      | undefined;
  }

  private get sidebarElement() {
    return document?.getElementById("panel-sidebar-box") as unknown as
      | XULElement
      | undefined;
  }

  private get browsers() {
    return document?.querySelectorAll(".sidebar-panel-browser") as
      | NodeListOf<XULElement>
      | undefined;
  }

  constructor() {
    this.owner = getOwner();
    const exec = () => {
      createEffect(() => {
        // Only clear selection marker from sidebar panels (not workspaces).
        const currentCheckedPanels = Array.from(
          document?.querySelectorAll(
            ".panel-sidebar-panel[data-checked][data-panel-id]",
          ) ?? [],
        );
        // Use forEach instead of map to avoid type error
        (currentCheckedPanels as XULElement[]).forEach((panel) => {
          panel.removeAttribute("data-checked");
        });

        const currentPanel = this.getPanelData(selectedPanelId() ?? "");
        if (currentPanel) {
          document
            // Select by data-panel-id to avoid touching workspace entries.
            ?.querySelector(
              `.panel-sidebar-panel[data-panel-id="${currentPanel.id}"]`,
            )
            ?.setAttribute("data-checked", "true");
        }
      });
    };
    if (this.owner) runWithOwner(this.owner, exec);
    else createRoot(exec);

    // Dark Bork can flip live; keep every static panel's scheme current.
    // Static panels only — web panels are ordinary websites and keep the
    // user's normal content scheme.
    const schemeObserver = new MutationObserver(() => {
      for (const p of panelSidebarData()) {
        if (p.type !== "static") continue;
        const b = this.getBrowserElement(p.id);
        if (b) {
          this.syncPanelScheme(b);
          this.applyEmbedTweaks(b);
        }
      }
    });
    if (document?.documentElement) {
      schemeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-bork-dark"],
      });
    }
  }

  /**
   * Static panels must follow Dark Bork, not the OS. The in-process
   * chrome-doc panels (bookmarks/history/places/synced tabs/notes) inherit
   * the embedder's color-scheme through style.css — the same mechanism
   * #sidebar-box uses in browser/themes/shared/sidebar.css — but the
   * remote about: panels (downloads, translations) are top-level content
   * and take their scheme from the platform: a light GTK theme rendered
   * them light grey inside black chrome on linux.
   * prefersColorSchemeOverride is the supported lever for a content
   * browsing context — and ONLY for content: writing it on an in-process
   * chrome browsing context SEGFAULTS FF152 in the synced-context commit
   * (BrowsingContext::SetPrefersColorSchemeOverride →
   * Transaction::Commit, symbolicated from a live crash), so the chrome
   * panels must never reach the write.
   */
  /** Adopted dark-surface sheets, one per embedded document. */
  private embedSheets = new WeakMap<Document, CSSStyleSheet>();

  /**
   * Per-document corrections to the embedded static panels — in-process
   * docs only; the remote about: panels need none of this.
   *
   * - FF152's places sidebar documents carry their own panel header whose
   *   close button drives the MAIN window's SidebarController
   *   (bookmarksSidebar.js closeSidebarPanel → embedderWindowGlobal →
   *   SidebarController.toggle): inside this embedding that pops the
   *   native sidebar open on the far side of the window instead of
   *   closing anything. The floorp header above the panel already has the
   *   one real close button; hide the embedded duplicate. The hidden
   *   ATTRIBUTE, not an injected <style> — these documents ship their own
   *   CSP (`default-src chrome:`) which silently kills inline sheets (the
   *   element appends fine but .sheet stays null).
   * - syncedtabs paints its :root with the platform Field colour, and
   *   GTK's dark Field is a mid grey — the one panel that stayed light
   *   grey inside black chrome. The same CSP applies, so the repaint
   *   rides a CONSTRUCTED, adopted stylesheet: created by script, never
   *   loaded, outside CSP's jurisdiction. Dark Bork only, and scoped to
   *   that document — the places docs' surfaces are already right.
   */
  private applyEmbedTweaks(browser: XULElement) {
    try {
      const doc = (browser as unknown as {
        contentDocument?: Document | null;
      }).contentDocument;
      if (!doc?.documentElement) return;
      const hdr = doc.getElementById("sidebar-panel-header") as
        | (Element & { hidden: boolean })
        | null;
      if (hdr) {
        hdr.hidden = true;
      }
      if (!doc.documentURI.includes("syncedtabs")) return;
      const win = doc.defaultView as
        | (Window & { CSSStyleSheet: { new (): CSSStyleSheet } })
        | null;
      if (!win) return;
      const dark = document?.documentElement?.hasAttribute("data-bork-dark") ??
        false;
      type AdoptingDoc = Document & { adoptedStyleSheets: CSSStyleSheet[] };
      const adoc = doc as AdoptingDoc;
      const existing = this.embedSheets.get(doc);
      if (dark && !existing) {
        const sheet = new win.CSSStyleSheet();
        (sheet as unknown as { replaceSync(text: string): void }).replaceSync(
          ":root { background-color: #050506 !important; }",
        );
        adoc.adoptedStyleSheets = [...adoc.adoptedStyleSheets, sheet];
        this.embedSheets.set(doc, sheet);
      } else if (!dark && existing) {
        adoc.adoptedStyleSheets = adoc.adoptedStyleSheets.filter(
          (s) => s !== existing,
        );
        this.embedSheets.delete(doc);
      }
    } catch (e) {
      console.error("[panel-sidebar] embed tweaks failed:", e);
    }
  }

  private syncPanelScheme(browser: XULElement) {
    try {
      if (browser.getAttribute("remote") !== "true") {
        return;
      }
      const dark = document?.documentElement?.hasAttribute("data-bork-dark") ??
        false;
      const bc = (browser as unknown as {
        browsingContext?: { prefersColorSchemeOverride: string } | null;
      }).browsingContext;
      if (bc) {
        bc.prefersColorSchemeOverride = dark ? "dark" : "none";
      }
    } catch (e) {
      console.error("[panel-sidebar] scheme sync failed:", e);
    }
  }

  private owner: Owner | null = null;

  public getBrowserElement(id: string) {
    return document?.getElementById(`sidebar-panel-${id}`) as unknown as
      | (XULElement & {
        contentWindow: Window;
        goBack: () => void;
        goForward: () => void;
        goIndex: () => void;
        reload: () => void;
        toggleMute: () => void;
      })
      | undefined;
  }

  public getPanelData(id: string): Panel | undefined {
    return panelSidebarData().find((panel) => panel.id === id);
  }

  private createBrowserComponent(panel: Panel) {
    // No "web" entry: web panels hosted their site inside a nested
    // chrome://browser/content/browser.xhtml — an entire second browser UI
    // living in the sidebar, laid out in the parent process. Panels are
    // links now, so anything left over is migrated to a static panel.
    const components = {
      extension: ExtensionSiteBrowser,
      static: ChromeSiteBrowser,
    } as const;

    const BrowserComponent = components[panel.type];
    if (!BrowserComponent) {
      throw new Error(`Unsupported panel type: ${panel.type}`);
    }

    return <BrowserComponent {...panel} />;
  }

  private resetBrowsersFlex(): void {
    if (this.browsers) {
      for (const browser of this.browsers as Iterable<XULElement>) {
        (browser as XULElement).removeAttribute("flex");
      }
    }
  }

  private renderBrowserComponent(panel: Panel): void {
    if (!this.parentElement) {
      throw new Error("Parent element not found");
    }

    // Dispose previous root for this panel if it exists (safety for re-renders)
    const prevDispose = this.panelDisposers.get(panel.id);
    if (prevDispose) {
      try {
        prevDispose();
      } catch (e) {
        console.warn("panel dispose failed", e);
      }
      this.panelDisposers.delete(panel.id);
    }

    const exec = () => {
      const dispose = render(
        () => this.createBrowserComponent(panel),
        this.parentElement as XULElement,
        {
          hotCtx: import.meta.hot,
        },
      );
      if (typeof dispose === "function") {
        this.panelDisposers.set(panel.id, dispose);
      }
    };
    if (this.owner) runWithOwner(this.owner, exec);
    else createRoot(exec);

    this.initBrowser(panel);
  }

  private initBrowser(panel: Panel) {
    if (panel.type === "static") {
      const browser = this.getBrowserElement(panel.id);
      if (browser) {
        browser.addEventListener(
          "load",
          () => {
            this.applyEmbedTweaks(browser);
            this.syncPanelScheme(browser);
          },
          true,
        );
        // Remote panels replace their frameloader (and with it the
        // browsingContext) on the remoteness switch — re-assert the
        // scheme on every new one.
        browser.addEventListener("XULFrameLoaderCreated", () => {
          this.syncPanelScheme(browser);
        });
        this.applyEmbedTweaks(browser);
        this.syncPanelScheme(browser);
      }
    }
    if (panel.type === "extension") {
      const browser = this.getBrowserElement(panel.id) as XULElement & {
        contentWindow: Window;
      };

      if (!browser) {
        throw new Error("Browser element not found");
      }

      if (!panel.extensionId) {
        throw new Error("Extension ID not found");
      }

      const sidebarAction = getExtensionSidebarAction(panel.extensionId);

      browser.addEventListener("DOMContentLoaded", () => {
        const oa = globalThis.E10SUtils.predictOriginAttributes({ browser });
        browser.setAttribute(
          "remoteType",
          globalThis.E10SUtils.getRemoteTypeForURI(
            panel.url ?? "",
            true,
            false,
            globalThis.E10SUtils.EXTENSION_REMOTE_TYPE,
            null,
            oa,
          ),
        );

        browser.contentWindow.loadPanel(
          panel.extensionId,
          sidebarAction.default_panel,
          "sidebar",
        );
      });
    }
  }

  public changePanel(panelId: string): void {
    if (panelId === selectedPanelId()) {
      // Closing a panel just hides it; the browser stays loaded so
      // reopening is instant and web panels keep their state and playback.
      // (Hardcoded — the autoUnload setting was removed. Explicit unload is
      // still available from the panel's context menu.)
      setSelectedPanelId(null);
      return;
    }

    const panel = this.getPanelData(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    setSelectedPanelId(panelId);
    this.setSidebarWidth(panel);
    this.resetBrowsersFlex();
    this.showPanel(panel);
  }

  public showPanel(panel: Panel): void {
    const browser = this.getBrowserElement(panel.id);
    if (browser) {
      browser.setAttribute("flex", "1");
      return;
    }
    this.renderBrowserComponent(panel);
  }

  public saveCurrentSidebarWidth() {
    const currentWidth = this.sidebarElement?.getAttribute("width");
    if (currentWidth) {
      setPanelSidebarData((prev) =>
        prev.map((panel) =>
          panel.id === selectedPanelId()
            ? { ...panel, width: Number(currentWidth) }
            : panel
        )
      );
    }
  }

  private setSidebarWidth(panel: Panel) {
    this.sidebarElement?.style.setProperty(
      "width",
      `${panel.width !== 0 ? panel.width : panelSidebarConfig().globalWidth}px`,
    );
  }

  public openInMainWindow(panelId: string) {
    const url = this.getPanelData(panelId)?.url ?? "";
    const userContextId = this.getPanelData(panelId)?.userContextId ??
      undefined;
    globalThis.gBrowser.addTab(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      inBackground: false,
      userContextId: userContextId,
    });
  }

  public deletePanel(panelId: string) {
    this.unloadPanel(panelId);
    setPanelSidebarData((prev) => prev.filter((p) => p.id !== panelId));
  }

  public unloadPanel(panelId: string) {
    // Cleanup Solid root for this panel if present
    const dispose = this.panelDisposers.get(panelId);
    if (dispose) {
      try {
        dispose();
      } catch (e) {
        console.warn("panel dispose failed", e);
      }
      this.panelDisposers.delete(panelId);
    }

    const browser = this.getBrowserElement(panelId);
    if (browser) {
      browser.remove();
    }

    setSelectedPanelId(null);
  }

  public mutePanel(panelId: string) {
    const gWebsitePanel = WebsitePanel.getInstance();
    gWebsitePanel.toggleMutePanel(panelId);
  }

  public changeZoomLevel(panelId: string, type: "in" | "out" | "reset") {
    const gWebsitePanel = WebsitePanel.getInstance();

    switch (type) {
      case "in":
        gWebsitePanel.zoomInPanel(panelId);
        break;
      case "out":
        gWebsitePanel.zoomOutPanel(panelId);
        break;
      case "reset":
        gWebsitePanel.resetZoomLevelPanel(panelId);
        break;
    }
  }

  public changeUserAgent(panelId: string) {
    const panel = this.getPanelData(panelId);
    if (!panel) {
      throw new Error(`Panel not found: ${panelId}`);
    }

    // Toggle the userAgent property for the specified panel
    setPanelSidebarData((prev) =>
      prev.map((p) => p.id === panelId ? { ...p, userAgent: !p.userAgent } : p)
    );

    // Unload and reload the panel to apply the new user agent
    this.unloadPanel(panelId);
    this.changePanel(panelId);
  }
}
