/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  noraComponent,
  NoraComponentBase,
} from "#features-chrome/utils/base.ts";
import type {
  MetalinkDocument,
  MetalinkDownloaderModule,
  MetalinkIntegrationModule,
  MetalinkErrorPayload,
  MetalinkFile,
  MetalinkModule,
  MetalinkOpenPayload,
  MetalinkServiceModule,
  MetalinkUrl,
} from "./types.ts";

const METALINK_OPEN_TOPIC = "bork-metalink-open";
const METALINK_ERROR_TOPIC = "bork-metalink-error";

const MODULE_URI = "resource://noraneko/modules/Metalink.sys.mjs";
const DOWNLOADER_URI = "resource://noraneko/modules/MetalinkDownloader.sys.mjs";
const INTEGRATION_URI =
  "resource://noraneko/modules/MetalinkDownloadIntegration.sys.mjs";
const SERVICE_URI = "resource://noraneko/modules/MetalinkService.sys.mjs";
const HTTP_URI = "resource://noraneko/modules/MetalinkHttp.sys.mjs";

const MENU_ID = "bork-metalink-mirrors";
const PREF_ENABLED = "bork.metalink.enabled";

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
 * - Right-clicking a link to one offers "Show Mirrors", which opens a generated
 *   page listing every mirror the document names.
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

    this.buildMirrorMenuItem();
    this.menuListener = () => this.onContextMenuShowing();
    document?.getElementById("contentAreaContextMenu")
      ?.addEventListener("popupshowing", this.menuListener);

    this.markMetalinkDownloads();

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
      this.mirrorMenuItem?.remove();
      this.mirrorMenuItem = null;
    } catch (e) {
      console.error("[Metalink] teardown", e);
    }
  }

  /**
   * Badge our downloads in the downloads panel.
   *
   * The richlistitem for a download has no hook for extra state, so watch the
   * list for items appearing and stamp `bork-metalink="true"` on the ones whose
   * Download object we own. The theme paints the marker off that attribute —
   * see skin/bork/css/bork.css. A MutationObserver rather than a
   * DownloadsView override because the panel rebuilds its items on every open,
   * and overriding onDownloadAdded only catches the first construction.
   *
   * The attribute is stamped whatever the state; the stylesheet is what limits
   * the mark to a live transfer, so nothing here has to track state changes.
   */
  private markMetalinkDownloads(): void {
    const integration = ChromeUtils.importESModule(
      INTEGRATION_URI,
    ) as MetalinkIntegrationModule;

    const stamp = (root: ParentNode) => {
      for (const item of Array.from(root.querySelectorAll("richlistitem"))) {
        const dl = (item as unknown as { _shell?: { download?: object } })
          ._shell?.download;
        if (!dl) continue;
        if (!integration.isMetalinkDownload(dl)) continue;
        item.setAttribute("bork-metalink", "true");
        // Refresh the tooltip every pass rather than only on first stamp: the
        // details are stamped while the transfer is still running, so the
        // verification result is not known yet and would otherwise never
        // appear.
        const d = integration.metalinkDetails(dl);
        if (d) {
          const tip = `Metalink: ${d.usedMirrors || d.mirrorCount} mirror(s)` +
            (d.verified ? `, ${d.hashType} verified` : "");
          if (item.getAttribute("bork-metalink-tooltip") !== tip) {
            item.setAttribute("bork-metalink-tooltip", tip);
            item.setAttribute("tooltiptext", tip);
          }
        }
      }
    };

    const stampAll = () => {
      const box = document?.getElementById("downloadsListBox");
      if (box) stamp(box);
      const richList = document?.getElementById("downloadsRichListBox");
      if (richList) stamp(richList);
    };

    const observer = new MutationObserver(stampAll);

    const panel = document?.getElementById("downloadsPanel");
    if (panel) {
      observer.observe(panel, { childList: true, subtree: true });
      // Also on open. The observer only fires on DOM changes, and a download
      // that finished while the panel was closed mutates nothing — so the
      // verification result would never reach the tooltip without this.
      panel.addEventListener("popupshown", stampAll);
    }

    globalThis.addEventListener("unload", () => {
      observer.disconnect();
      panel?.removeEventListener("popupshown", stampAll);
    }, { once: true });
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

    const mirrors = metalink.orderMirrors(file, this.homeCountry());
    if (!mirrors.length) {
      this.notify(`Metalink: ${file.name} lists no usable mirrors.`);
      return;
    }
    const hash = metalink.strongestHash(file);

    try {
      const target = await downloader.targetPathFor(file.name);

      // Goes through Downloads.sys.mjs, so it appears in the downloads panel
      // and about:downloads with a working progress bar and Cancel button.
      const integration = ChromeUtils.importESModule(
        INTEGRATION_URI,
      ) as MetalinkIntegrationModule;
      const { completion } = await integration.startSegmentedDownload(
        file,
        mirrors,
        hash,
        target,
      );
      const result = await completion;

      if (!result) return;

      if (result.cancelled) return;

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
    if (r.cancelled) return;
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

  /**
   * "Show Mirrors" lives in the DOM from startup, hidden.
   *
   * It is not created during popupshowing. Building menu elements there and
   * opening them crashes Gecko; popupshowing only flips `hidden`.
   */
  private mirrorMenuItem: XULElement | null = null;
  private mirrorUrl: string | null = null;

  private buildMirrorMenuItem(): void {
    const menu = document?.getElementById("contentAreaContextMenu");
    if (!menu) return;
    // Adopt an existing one rather than bailing: returning without assigning
    // left the handler with a null item and it silently did nothing.
    const existing = menu.querySelector(`#${MENU_ID}`) as XULElement | null;
    if (existing) {
      this.mirrorMenuItem = existing;
      return;
    }
    const item = document!.createXULElement("menuitem") as XULElement;
    item.id = MENU_ID;
    item.setAttribute("label", "Show Mirrors");
    item.setAttribute("hidden", "true");
    item.addEventListener("command", () => {
      const url = this.mirrorUrl;
      if (url) {
        this.showMirrorsPage(url).catch((e) => {
          console.error("[Metalink] mirror page", e);
          this.notify(`Metalink: could not read ${url}`);
        });
      }
    });
    menu.appendChild(item);
    this.mirrorMenuItem = item;
  }

  private onContextMenuShowing(): void {
    const item = this.mirrorMenuItem ??
      (document?.getElementById(MENU_ID) as XULElement | null);
    if (!item) return;

    const ctx = (globalThis as { gContextMenu?: { onLink?: boolean; linkURL?: string } })
      .gContextMenu;
    const url = ctx?.onLink ? ctx.linkURL : undefined;
    const show = !!url &&
      isMetalinkUrl(url) &&
      Services.prefs.getBoolPref(PREF_ENABLED, true);

    this.mirrorUrl = show ? url! : null;
    item.hidden = !show;
  }

  /**
   * Read the Metalink and open a generated page listing its mirrors. Runs
   * after the menu has closed, so there is no menu left to disturb.
   */
  private async showMirrorsPage(url: string): Promise<void> {
    const svc = ChromeUtils.importESModule(SERVICE_URI) as MetalinkServiceModule;
    const metalink = ChromeUtils.importESModule(MODULE_URI) as MetalinkModule;

    const doc = await svc.readMetalinkUrl(url);
    if (!doc.files.length) {
      this.notify("Metalink: no files described in that document.");
      return;
    }

    const html = renderMirrorsPage(
      doc,
      url,
      (f) => metalink.orderMirrors(f, this.homeCountry()),
    );

    // A real file rather than a data: URL — top-level data: navigation is
    // blocked, and this way the page can simply be reloaded.
    const path = PathUtils.join(
      PathUtils.tempDir,
      `bork-mirrors-${Date.now()}.html`,
    );
    await IOUtils.writeUTF8(path, html);

    (globalThis as {
      openTrustedLinkIn?: (u: string, where: string) => void;
    }).openTrustedLinkIn?.(PathUtils.toFileURI(path), "tab");
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

/** Escape for HTML text and attribute contexts — mirror URLs come off the
 *  network and land in a document. */
function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The generated mirrors page. Self-contained: no network, no script. */
function renderMirrorsPage(
  doc: MetalinkDocument,
  sourceUrl: string,
  order: (f: MetalinkFile) => MetalinkUrl[],
): string {
  const files = doc.files.map((f) => {
    const mirrors = order(f);
    const rows = mirrors.map((m, i) => `
        <tr>
          <td class="n">${i + 1}</td>
          <td>${m.location ? `<span class="cc">${esc(m.location)}</span>` : ""}</td>
          <td class="host">${esc((() => { try { return new URL(m.url).host; } catch { return m.url; } })())}</td>
          <td class="pri">${m.priority ?? ""}</td>
          <td class="url"><a href="${esc(m.url)}">${esc(m.url)}</a></td>
        </tr>`).join("");

    const hashes = f.hashes.map((h) =>
      `<div class="hash"><span class="ht">${esc(h.type)}</span><code>${esc(h.value)}</code></div>`
    ).join("");

    const torrents = f.metaurls.filter((m) => m.mediatype === "torrent")
      .map((m) => `<a href="${esc(m.url)}">${esc(m.url)}</a>`).join("<br>");

    return `
    <section class="file">
      <h2>${esc(f.name)}</h2>
      <p class="meta">
        ${f.size !== undefined ? `<span>${esc(formatSize(f.size))}</span>` : ""}
        ${f.version ? `<span>v${esc(f.version)}</span>` : ""}
        ${f.os.length ? `<span>${esc(f.os.join(", "))}</span>` : ""}
        ${f.language.length ? `<span>${esc(f.language.join(", "))}</span>` : ""}
        <span>${mirrors.length} mirror${mirrors.length === 1 ? "" : "s"}</span>
      </p>
      ${f.description ? `<p class="desc">${esc(f.description)}</p>` : ""}
      ${hashes ? `<div class="hashes">${hashes}</div>` : ""}
      ${torrents ? `<p class="torrent">BitTorrent: ${torrents}<br><small>bork does not open torrents — copy this into a torrent client.</small></p>` : ""}
      <table>
        <thead><tr><th></th><th></th><th>Host</th><th>Priority</th><th>URL</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Mirrors — ${esc(doc.files[0]?.name ?? "Metalink")}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:40px 32px; background:#050506; color:#e8e6e3;
         font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .wrap { max-width: 1100px; margin: 0 auto; }
  header { display:flex; align-items:center; gap:14px; margin-bottom:28px;
           padding-bottom:20px; border-bottom:1px solid #26262c; }
  header img { width:34px; height:auto; }
  header h1 { margin:0; font-size:1.05rem; font-weight:600; letter-spacing:.02em;
              text-transform:uppercase; color:#f6f5f4; }
  header .src { margin-left:auto; font-size:.75rem; color:#8b8a92;
                font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
                max-width:50ch; overflow-wrap:anywhere; }
  .file { margin-bottom:44px; }
  .file h2 { font-size:1.5rem; margin:0 0 8px; letter-spacing:-.02em; overflow-wrap:anywhere; }
  .meta { margin:0 0 10px; color:#8b8a92; font-size:.82rem;
          font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .meta span + span::before { content:"·"; margin:0 8px; color:#44444c; }
  .desc { margin:0 0 14px; color:#c9c7c4; }
  .hashes { margin:0 0 18px; }
  .hash { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.74rem;
          color:#8b8a92; overflow-wrap:anywhere; margin-bottom:3px; }
  .ht { display:inline-block; min-width:70px; color:#ff8a1f; }
  .torrent { font-size:.8rem; color:#8b8a92; margin:0 0 18px; overflow-wrap:anywhere; }
  table { width:100%; border-collapse:collapse; font-size:.86rem; }
  thead th { text-align:left; font-weight:600; font-size:.68rem; letter-spacing:.14em;
             text-transform:uppercase; color:#6f6e77; padding:0 10px 8px;
             border-bottom:1px solid #26262c; }
  td { padding:8px 10px; border-bottom:1px solid #17171b; vertical-align:top; }
  tbody tr:hover { background:#101014; }
  .n { color:#55545c; font-variant-numeric:tabular-nums; width:1%; }
  .cc { background:#1c1c22; color:#ff8a1f; border-radius:3px; padding:1px 6px;
        font-size:.72rem; font-weight:600; letter-spacing:.04em; }
  .host { font-weight:500; }
  .pri { color:#8b8a92; font-variant-numeric:tabular-nums; }
  .url { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.74rem;
         overflow-wrap:anywhere; }
  .url a { color:#8b8a92; text-decoration:none; }
  .url a:hover { color:#ff8a1f; text-decoration:underline; }
  footer { margin-top:40px; padding-top:18px; border-top:1px solid #26262c;
           color:#6f6e77; font-size:.78rem; }
</style></head>
<body><div class="wrap">
<header>
  <img src="chrome://noraneko-skin/content/bork/icons/metalinker.png" alt="">
  <h1>Metalink mirrors</h1>
  <span class="src">${esc(sourceUrl)}</span>
</header>
${files}
<footer>Clicking a mirror downloads from that one alone. Opening the
<code>.meta4</code> itself downloads from several at once and verifies the
checksum.</footer>
</div></body></html>`;
}
