/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Panel } from "./type.ts";
import { STATIC_PANEL_DATA } from "../data/static-panels.ts";
import { getSidebarIconFromSidebarController } from "../extension-panels.ts";

const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs",
);

const DEFAULT_FAVICON = "chrome://devtools/skin/images/globe.svg";

const gFavicons = PlacesUtils.favicons as {
  getFaviconForPage: (
    uri: nsIURI,
  ) => Promise<{ uri: nsIURI }>;
};

export async function getFaviconURLForPanel(panel: Panel): Promise<string> {
  try {
    await globalThis.SessionStore.promiseInitialized;
    const url = panel.url ?? "";
    // bork: the bundled docs panel carries a generic help glyph — the
    // site favicon is the Floorp logo, which reads as browser branding.
    if (url.startsWith("https://docs.floorp.app")) {
      return "chrome://global/skin/icons/help.svg";
    }
    // Only attempt Places favicon lookup for regular web URLs
    if (
      panel.type !== "web" ||
      !url.startsWith("http://") && !url.startsWith("https://")
    ) {
      return getFallbackFavicon(panel);
    }
    const faviconURL = await getFaviconFromPlaces(url);
    return faviconURL ?? getFallbackFavicon(panel);
  } catch {
    // Swallow errors and fall back to default icon to avoid console noise
    return getFallbackFavicon(panel);
  }
}

async function getFaviconFromPlaces(url: string): Promise<string | undefined> {
  if (!url) {
    return undefined;
  }

  try {
    const uri = Services.io.newURI(url);
    const result = await gFavicons.getFaviconForPage(uri);
    return result.uri?.spec ?? undefined;
  } catch {
    return undefined;
  }
}

function getFaviconFromExtension(extensionId: string): string {
  return getSidebarIconFromSidebarController(extensionId) ?? "";
}

function getFallbackFavicon(panel: Panel): string {
  switch (panel.type) {
    case "static":
      return (
        STATIC_PANEL_DATA[panel.url as keyof typeof STATIC_PANEL_DATA].icon ??
          DEFAULT_FAVICON
      );
    case "extension":
      return getFaviconFromExtension(panel.extensionId ?? "");
    default:
      if (
        panel.url?.startsWith("http://") ||
        panel.url?.startsWith("https://")
      ) {
        return `https://www.google.com/s2/favicons?domain=${panel.url}&sz=32`;
      }
      return DEFAULT_FAVICON;
  }
}
