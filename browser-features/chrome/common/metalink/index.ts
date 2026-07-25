/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  noraComponent,
  NoraComponentBase,
} from "#features-chrome/utils/base.ts";
import ModalParent from "../modal-parent/index.ts";
import type { TForm } from "../modal-parent/utils/type.ts";
import type {
  MetalinkDownloaderModule,
  MetalinkErrorPayload,
  MetalinkModule,
  MetalinkOpenPayload,
  MetalinkServiceModule,
} from "./types.ts";

const METALINK_OPEN_TOPIC = "bork-metalink-open";
const METALINK_ERROR_TOPIC = "bork-metalink-error";

const MODULE_URI = "resource://noraneko/modules/Metalink.sys.mjs";
const DOWNLOADER_URI = "resource://noraneko/modules/MetalinkDownloader.sys.mjs";
const SERVICE_URI = "resource://noraneko/modules/MetalinkService.sys.mjs";
const HTTP_URI = "resource://noraneko/modules/MetalinkHttp.sys.mjs";

/** Human sizes for the picker; Metalink sizes are octets. */
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

/** "us" -> a flag-ish label the picker can show without a locale database. */
function describeMirror(
  url: string,
  location?: string,
  priority?: number,
): string {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // keep the raw string
  }
  const bits: string[] = [host];
  if (location) bits.push(location);
  if (priority !== undefined) bits.push(`priority ${priority}`);
  return bits.join(" · ");
}

/**
 * Metalink support: a `.meta4`/`.metalink` opens a picker listing the mirrors,
 * then downloads from the chosen one with automatic failover and checksum
 * verification.
 *
 * The parsing, downloading and RFC 6249 header work all live in the ESM layer
 * (Metalink*.sys.mts). This class is only the window-side glue: it observes the
 * service's broadcasts and drives the modal.
 */
@noraComponent(import.meta.hot)
export default class Metalink extends NoraComponentBase {
  private observer: nsIObserver | null = null;
  private errorObserver: nsIObserver | null = null;

  init(): void {
    try {
      const service = ChromeUtils.importESModule(
        SERVICE_URI,
      ) as MetalinkServiceModule;
      service.registerMetalinkHandler();

      const http = ChromeUtils.importESModule(HTTP_URI) as {
        startMetalinkHttp(): void;
      };
      http.startMetalinkHttp();
    } catch (e) {
      console.error("[Metalink] could not start the service", e);
      return;
    }

    this.observer = {
      QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
      observe: (_s: nsISupports, _t: string, data: string) => {
        // Every window observes the same broadcast; only the focused one should
        // put a modal on screen, or opening one .meta4 shows N pickers.
        if (Services.focus.activeWindow !== globalThis) return;
        this.onOpen(data).catch((e) => console.error("[Metalink]", e));
      },
    } as nsIObserver;

    this.errorObserver = {
      QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
      observe: (_s: nsISupports, _t: string, data: string) => {
        if (Services.focus.activeWindow !== globalThis) return;
        try {
          const payload = JSON.parse(data) as MetalinkErrorPayload;
          this.notify(`Metalink: ${payload.error}`);
        } catch {
          this.notify("Metalink: the document could not be read.");
        }
      },
    } as nsIObserver;

    Services.obs.addObserver(this.observer, METALINK_OPEN_TOPIC, false);
    Services.obs.addObserver(this.errorObserver, METALINK_ERROR_TOPIC, false);

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
    } catch (e) {
      console.error("[Metalink] teardown", e);
    }
  }

  private async onOpen(data: string): Promise<void> {
    const payload = JSON.parse(data) as MetalinkOpenPayload;
    const file = payload.document.files[payload.suggested.fileIndex];
    if (!file) return;

    const metalink = ChromeUtils.importESModule(MODULE_URI) as MetalinkModule;
    const downloader = ChromeUtils.importESModule(
      DOWNLOADER_URI,
    ) as MetalinkDownloaderModule;

    const ordered = metalink.orderMirrors(file, this.homeCountry());
    if (!ordered.length) {
      this.notify(`Metalink: ${file.name} lists no usable mirrors.`);
      return;
    }

    const hash = metalink.strongestHash(file);

    const detail = [
      formatSize(file.size),
      file.version ? `v${file.version}` : "",
      file.description ?? "",
    ].filter(Boolean).join(" · ");

    const forms: TForm = {
      title: detail ? `${file.name} — ${detail}` : file.name,
      submitLabel: "Download",
      cancelLabel: "Cancel",
      forms: [
        {
          type: "dropdown",
          id: "mirror",
          label: `Mirror (${ordered.length} available)`,
          value: ordered[0].url,
          options: ordered.map((m) => ({
            label: describeMirror(m.url, m.location, m.priority),
            value: m.url,
          })),
        },
        {
          type: "checkbox",
          id: "verify",
          label: hash
            ? `Verify ${hash.type.toUpperCase()} after downloading`
            : "No checksum in this document — cannot verify",
          value: hash ? "true" : "",
        },
      ],
    };

    // A torrent source is listed but not actionable here; say so rather than
    // silently dropping metadata the document went to the trouble of carrying.
    const torrent = file.metaurls.find((m) => m.mediatype === "torrent");
    if (torrent) {
      forms.forms.push({
        type: "checkbox",
        id: "copyTorrent",
        label: "Also copy the BitTorrent link (bork cannot open torrents)",
        value: "",
      });
    }

    await ModalParent.getInstance().showNoraModal(
      forms,
      { width: 560, height: 300 },
      (result) => {
        if (!result) return;
        const chosen = String(result["mirror"] ?? ordered[0].url);
        if (torrent && String(result["copyTorrent"]) === "true") {
          this.copyToClipboard(torrent.url);
        }
        // Put the chosen mirror first, keep the rest as failover in order.
        const mirrors = [
          ...ordered.filter((m) => m.url === chosen),
          ...ordered.filter((m) => m.url !== chosen),
        ];
        const verify = String(result["verify"]) === "true" ? hash : undefined;

        downloader.downloadMetalinkFile(file, mirrors, verify)
          .then((r) => {
            if (r.ok) {
              const how = r.verified
                ? `verified ${r.hashType}`
                : "not verified";
              const failed = r.attempts.filter((a) => !a.ok).length;
              this.notify(
                `${file.name} downloaded (${how})` +
                  (failed ? ` after ${failed} failed mirror(s)` : ""),
              );
            } else {
              this.notify(`${file.name} failed: ${r.error ?? "unknown error"}`);
            }
          })
          .catch((e) => {
            console.error("[Metalink] download", e);
            this.notify(`${file.name} failed: ${String(e)}`);
          });
      },
    );
  }

  /**
   * Best guess at the user's country for mirror selection, from the locale.
   * Deliberately not a geo-IP lookup: that is a network request to a third
   * party on every download, to save at most one failover.
   */
  private homeCountry(): string | undefined {
    try {
      const locale = Services.locale.appLocaleAsBCP47;
      const region = new Intl.Locale(locale).region;
      return region?.toUpperCase();
    } catch {
      return undefined;
    }
  }

  private copyToClipboard(text: string): void {
    try {
      const helper = Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper);
      helper.copyString(text);
    } catch (e) {
      console.error("[Metalink] clipboard", e);
    }
  }

  private notify(message: string): void {
    const box = (globalThis as { gNotificationBox?: NotificationBoxLike })
      .gNotificationBox;
    if (!box) {
      console.log("[Metalink]", message);
      return;
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
}
