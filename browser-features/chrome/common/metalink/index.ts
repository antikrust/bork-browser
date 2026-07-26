/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  noraComponent,
  NoraComponentBase,
} from "#features-chrome/utils/base.ts";
import type {
  MetalinkDownloaderModule,
  MetalinkErrorPayload,
  MetalinkFile,
  MetalinkModule,
  MetalinkOpenPayload,
  MetalinkSegmentedModule,
  MetalinkServiceModule,
  MetalinkUrl,
} from "./types.ts";

const METALINK_OPEN_TOPIC = "bork-metalink-open";
const METALINK_ERROR_TOPIC = "bork-metalink-error";

const MODULE_URI = "resource://noraneko/modules/Metalink.sys.mjs";
const DOWNLOADER_URI = "resource://noraneko/modules/MetalinkDownloader.sys.mjs";
const SEGMENTED_URI = "resource://noraneko/modules/MetalinkSegmented.sys.mjs";
const SERVICE_URI = "resource://noraneko/modules/MetalinkService.sys.mjs";
const HTTP_URI = "resource://noraneko/modules/MetalinkHttp.sys.mjs";

const MENU_ID = "bork-metalink-mirrors";

function formatSize(bytes?: number): string {
  if (bytes === undefined) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${u === 0 ? n : n.toFixed(1)} ${units[u]}`;
}

function describeMirror(m: MetalinkUrl): string {
  let host = m.url;
  try {
    host = new URL(m.url).host;
  } catch {
    // keep the raw string
  }
  const bits = [host];
  if (m.location) bits.push(m.location);
  if (m.priority !== undefined) bits.push(`priority ${m.priority}`);
  return bits.join(" · ");
}

function isMetalinkUrl(url: string): boolean {
  try {
    const p = new URL(url).pathname.toLowerCase();
    return p.endsWith(".meta4") || p.endsWith(".metalink");
  } catch {
    return false;
  }
}

/**
 * Metalink support.
 *
 * - Opening a `.meta4`/`.metalink` starts a SEGMENTED download straight away:
 *   the file is pulled from several mirrors at once and reassembled. No dialog.
 * - Right-clicking a link to one lists the mirrors in the context menu; picking
 *   one downloads from that mirror alone.
 *
 * Parsing, transport and the RFC 6249 header work live in the ESM layer
 * (Metalink*.sys.mts). This class is window-side glue only.
 */
@noraComponent(import.meta.hot)
export default class Metalink extends NoraComponentBase {
  private observer: nsIObserver | null = null;
  private errorObserver: nsIObserver | null = null;
  private menuListener: ((e: Event) => void) | null = null;

  init(): void {
    try {
      (ChromeUtils.importESModule(SERVICE_URI) as MetalinkServiceModule)
        .registerMetalinkHandler();
      (ChromeUtils.importESModule(HTTP_URI) as { startMetalinkHttp(): void })
        .startMetalinkHttp();
    } catch (e) {
      console.error("[Metalink] could not start the service", e);
      return;
    }

    this.observer = {
      QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
      observe: (_s: nsISupports, _t: string, data: string) => {
        // Every window observes the same broadcast; only one should act, or a
        // single .meta4 starts N downloads.
        if (Services.focus.activeWindow !== globalThis) return;
        this.onOpen(data).catch((e) => console.error("[Metalink]", e));
      },
    } as nsIObserver;

    this.errorObserver = {
      QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
      observe: (_s: nsISupports, _t: string, data: string) => {
        if (Services.focus.activeWindow !== globalThis) return;
        let msg = "Metalink: the document could not be read.";
        try {
          msg = `Metalink: ${(JSON.parse(data) as MetalinkErrorPayload).error}`;
        } catch {
          // keep the generic message
        }
        this.notify(msg);
      },
    } as nsIObserver;

    Services.obs.addObserver(this.observer, METALINK_OPEN_TOPIC, false);
    Services.obs.addObserver(this.errorObserver, METALINK_ERROR_TOPIC, false);

    this.menuListener = () => this.onContextMenuShowing();
    document?.getElementById("contentAreaContextMenu")
      ?.addEventListener("popupshowing", this.menuListener);

    globalThis.addEventListener("unload", () => this.teardown(), {
      once: true,
    });
  }

  private teardown(): void {
    try {
      if (this.observer) {
        Services.obs.removeObserver(this.observer, METALINK_OPEN_TOPIC);
        this.observer = null;
      }
      if (this.errorObserver) {
        Services.obs.removeObserver(this.errorObserver, METALINK_ERROR_TOPIC);
        this.errorObserver = null;
      }
      if (this.menuListener) {
        document?.getElementById("contentAreaContextMenu")
          ?.removeEventListener("popupshowing", this.menuListener);
        this.menuListener = null;
      }
    } catch (e) {
      console.error("[Metalink] teardown", e);
    }
  }

  // --- click / navigation path: segmented download, no dialog ---

  private async onOpen(data: string): Promise<void> {
    const payload = JSON.parse(data) as MetalinkOpenPayload;
    const file = payload.document.files[payload.suggested.fileIndex];
    if (!file) return;

    const metalink = ChromeUtils.importESModule(MODULE_URI) as MetalinkModule;
    const downloader = ChromeUtils.importESModule(
      DOWNLOADER_URI,
    ) as MetalinkDownloaderModule;
    const segmented = ChromeUtils.importESModule(
      SEGMENTED_URI,
    ) as MetalinkSegmentedModule;

    const mirrors = metalink.orderMirrors(file, this.homeCountry());
    if (!mirrors.length) {
      this.notify(`Metalink: ${file.name} lists no usable mirrors.`);
      return;
    }
    const hash = metalink.strongestHash(file);

    this.notify(
      `${file.name} (${formatSize(file.size)}) — starting across ` +
        `${Math.min(mirrors.length, 6)} of ${mirrors.length} mirrors…`,
    );

    try {
      const target = await downloader.targetPathFor(file.name);
      const result = await segmented.downloadSegmented(
        file,
        mirrors,
        hash,
        target,
      );

      if (result.ok) {
        const used = Object.keys(result.contributions).length;
        this.notify(
          `${file.name} downloaded from ${used} mirror(s)` +
            (result.verified ? `, verified ${result.hashType}` : "") +
            (result.retiredMirrors.length
              ? ` — ${result.retiredMirrors.length} mirror(s) dropped`
              : ""),
        );
        return;
      }

      // Segmenting was not possible (too small, no size, no range support) or
      // it failed. Either way a plain single-mirror download still works, and
      // that one shows up in about:downloads.
      if (result.fellBackToSingle) {
        this.notify(`${file.name}: ${result.error} — using a single mirror.`);
      } else {
        this.notify(`${file.name}: ${result.error} — retrying on one mirror.`);
      }
      await this.singleMirror(file, mirrors, hash, downloader);
    } catch (e) {
      console.error("[Metalink] segmented download", e);
      this.notify(`${file.name} failed: ${String(e)}`);
    }
  }

  private async singleMirror(
    file: MetalinkFile,
    mirrors: MetalinkUrl[],
    hash: ReturnType<MetalinkModule["strongestHash"]>,
    downloader: MetalinkDownloaderModule,
  ): Promise<void> {
    const r = await downloader.downloadMetalinkFile(file, mirrors, hash);
    if (r.ok) {
      this.notify(
        `${file.name} downloaded${
          r.verified ? `, verified ${r.hashType}` : " (not verified)"
        }`,
      );
    } else {
      this.notify(`${file.name} failed: ${r.error ?? "unknown error"}`);
    }
  }

  // --- right-click path: list mirrors, download from the chosen one ---

  private onContextMenuShowing(): void {
    const menu = document?.getElementById("contentAreaContextMenu");
    if (!menu) return;

    // Rebuild every time: the link under the cursor changes between openings.
    menu.querySelector(`#${MENU_ID}`)?.remove();

    const ctx = (globalThis as { gContextMenu?: { onLink?: boolean; linkURL?: string } })
      .gContextMenu;
    if (!ctx?.onLink || !ctx.linkURL || !isMetalinkUrl(ctx.linkURL)) return;

    const url = ctx.linkURL;
    const item = document!.createXULElement("menu") as XULElement;
    item.id = MENU_ID;
    item.setAttribute("label", "Download from mirror");
    const popup = document!.createXULElement("menupopup");
    item.appendChild(popup);

    const loading = document!.createXULElement("menuitem") as XULElement;
    loading.setAttribute("label", "Loading mirrors…");
    loading.setAttribute("disabled", "true");
    popup.appendChild(loading);

    menu.appendChild(item);

    // Fetching is async and the menu is already on screen; fill it in when the
    // document arrives. If the user closes the menu first this is simply
    // discarded on the next popupshowing.
    this.populateMirrors(url, popup).catch((e) => {
      console.error("[Metalink] mirror menu", e);
      loading.setAttribute("label", "Could not read the Metalink");
    });
  }

  private async populateMirrors(
    url: string,
    popup: Element,
  ): Promise<void> {
    const svc = ChromeUtils.importESModule(SERVICE_URI) as MetalinkServiceModule;
    const metalink = ChromeUtils.importESModule(MODULE_URI) as MetalinkModule;
    const downloader = ChromeUtils.importESModule(
      DOWNLOADER_URI,
    ) as MetalinkDownloaderModule;

    const doc = await svc.readMetalinkUrl(url);
    const file = doc.files[0];
    if (!file || !file.urls.length) {
      popup.textContent = "";
      const none = document!.createXULElement("menuitem") as XULElement;
      none.setAttribute("label", "No mirrors listed");
      none.setAttribute("disabled", "true");
      popup.appendChild(none);
      return;
    }

    const mirrors = metalink.orderMirrors(file, this.homeCountry());
    const hash = metalink.strongestHash(file);

    popup.textContent = "";
    for (const m of mirrors) {
      const mi = document!.createXULElement("menuitem") as XULElement;
      mi.setAttribute("label", describeMirror(m));
      mi.addEventListener("command", () => {
        // Chosen mirror first; the rest stay as failover rather than being
        // discarded, so picking a mirror that has since died still works.
        const ordered = [
          ...mirrors.filter((x) => x.url === m.url),
          ...mirrors.filter((x) => x.url !== m.url),
        ];
        this.notify(`${file.name}: downloading from ${describeMirror(m)}`);
        this.singleMirror(file, ordered, hash, downloader)
          .catch((e) => console.error("[Metalink]", e));
      });
      popup.appendChild(mi);
    }
  }

  /**
   * Best guess at the user's country for mirror selection, from the locale.
   * Deliberately not a geo-IP lookup: that is a request to a third party on
   * every download, to save at most one failover.
   */
  private homeCountry(): string | undefined {
    try {
      return new Intl.Locale(Services.locale.appLocaleAsBCP47).region
        ?.toUpperCase();
    } catch {
      return undefined;
    }
  }

  private notify(message: string): void {
    const box = (globalThis as { gNotificationBox?: NotificationBoxLike })
      .gNotificationBox;
    if (!box) {
      console.log("[Metalink]", message);
      return;
    }
    try {
      box.removeNotification(box.getNotificationWithValue?.("bork-metalink"));
    } catch {
      // nothing to replace
    }
    box.appendNotification("bork-metalink", {
      label: message,
      priority: box.PRIORITY_INFO_MEDIUM,
    }, []);
  }
}

interface NotificationBoxLike {
  PRIORITY_INFO_MEDIUM: number;
  appendNotification(
    id: string,
    options: { label: string; priority: number },
    buttons: unknown[],
  ): void;
  getNotificationWithValue?(value: string): unknown;
  removeNotification(n: unknown): void;
}
