/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Catches Metalink documents on their way to the download manager and hands
 * them to bork's own handler instead.
 *
 * Mechanism is an nsIContentHandler factory registered over the contract ID
 * Gecko looks up for a given MIME type — the same registrar trick
 * NoranekoStartup uses to own `about:` pages, applied to
 * "what should Firefox do with this file" rather than to a URL scheme.
 * Registering our factory on the stock contract ID displaces the built-in
 * behaviour (which is "offer to save it", i.e. the user gets a .meta4 file on
 * disk that nothing can open).
 *
 * The service does no UI. It parses and then broadcasts, so the chrome layer
 * can render the mirror picker in whatever window is frontmost.
 */

import { parseMetalink, strongestHash } from "./Metalink.sys.mts";
import { fetchMetalinkDocument } from "./MetalinkDownloader.sys.mts";
import type { MetalinkDocument } from "./Metalink.sys.mts";

/** Broadcast when a Metalink document has been parsed and is ready to show. */
export const METALINK_OPEN_TOPIC = "bork-metalink-open";
/** Broadcast when one could not be parsed. */
export const METALINK_ERROR_TOPIC = "bork-metalink-error";

const PREF_ENABLED = "bork.metalink.enabled";

/**
 * notifyObservers takes an nsISupports subject; broadcasting without one is
 * normal and Gecko accepts null, but the generated typings do not model that.
 */
const NO_SUBJECT = null as unknown as nsISupports;

const CONTENT_TYPES = [
  "application/metalink4+xml",
  "application/metalink+xml",
];

function getComponentRegistrar(): nsIComponentRegistrar | null {
  const cm = Components.manager;
  const maybeQI =
    (cm as unknown as { QueryInterface?: (iid: nsIID) => unknown })
      .QueryInterface;
  if (typeof maybeQI !== "function") return null;
  return maybeQI.call(cm, Ci.nsIComponentRegistrar) as nsIComponentRegistrar;
}

/**
 * A parsed document plus where it came from. Passed to observers as a JSON
 * string: observer subjects cross module boundaries and a plain object would
 * arrive as an opaque wrapper in the chrome layer.
 */
export interface MetalinkOpenPayload {
  sourceUrl: string;
  document: MetalinkDocument;
  /** Index of the file we suggest, and its best hash, precomputed for the UI. */
  suggested: {
    fileIndex: number;
    hashType?: string;
  };
}

async function handleMetalinkUri(uri: string): Promise<void> {
  try {
    const xml = await fetchMetalinkDocument(uri);
    const doc = parseMetalink(xml);

    if (!doc.files.length) {
      Services.obs.notifyObservers(
        NO_SUBJECT,
        METALINK_ERROR_TOPIC,
        JSON.stringify({
          sourceUrl: uri,
          error: doc.warnings.length
            ? doc.warnings.join("; ")
            : "The Metalink document described no usable files.",
        }),
      );
      return;
    }

    const payload: MetalinkOpenPayload = {
      sourceUrl: uri,
      document: doc,
      suggested: {
        fileIndex: 0,
        hashType: strongestHash(doc.files[0])?.type,
      },
    };
    Services.obs.notifyObservers(
      NO_SUBJECT,
      METALINK_OPEN_TOPIC,
      JSON.stringify(payload),
    );
  } catch (e) {
    Services.obs.notifyObservers(
      NO_SUBJECT,
      METALINK_ERROR_TOPIC,
      JSON.stringify({
        sourceUrl: uri,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }
}

class MetalinkContentHandler {
  QueryInterface = ChromeUtils.generateQI(["nsIContentHandler"]);

  handleContent(
    _contentType: string,
    _windowContext: nsIInterfaceRequestor,
    request: nsIRequest,
  ): void {
    let uri: string | null = null;
    try {
      const qi = (request as { QueryInterface?: (iid: unknown) => unknown })
        .QueryInterface;
      const channel = typeof qi === "function"
        ? qi.call(request, Ci.nsIChannel) as nsIChannel
        : null;
      uri = channel?.URI?.spec ?? null;
    } catch {
      uri = null;
    }

    // Stop Gecko's own handling either way. Letting the request continue would
    // race our fetch and still drop a .meta4 in the downloads folder.
    try {
      request.cancel(Cr.NS_BINDING_ABORTED);
    } catch {
      // already dead
    }

    if (!uri) return;
    // The response observer in MetalinkHttp usually gets here first (it catches
    // the Content-Disposition: attachment case this factory cannot see at all).
    // Claim the URL so one document never opens two pickers.
    const { claimMetalinkUrl } = ChromeUtils.importESModule(
      "resource://noraneko/modules/MetalinkHttp.sys.mjs",
    ) as { claimMetalinkUrl(u: string): boolean };
    if (!claimMetalinkUrl(uri)) return;

    // Re-fetch rather than reading the cancelled channel's stream: the bytes
    // are small, the request is already being torn down, and a fresh fetch
    // keeps this off the necko listener path entirely.
    handleMetalinkUri(uri).catch((e) => console.error("[Metalink]", e));
  }
}

const factory: nsIFactory = {
  createInstance<T extends nsIID>(iid: T): nsQIResult<T> {
    return new MetalinkContentHandler().QueryInterface(iid);
  },
};

type ComponentID = ReturnType<typeof Services.uuid.generateUUID>;
const registeredCids: ComponentID[] = [];

/**
 * Register the handler for both Metalink media types. Idempotent; safe to call
 * from every window's startup even though only the first does anything.
 */
export function registerMetalinkHandler(): void {
  if (registeredCids.length) return;
  if (!Services.prefs.getBoolPref(PREF_ENABLED, true)) return;

  const registrar = getComponentRegistrar();
  if (!registrar) {
    console.error("[Metalink] no component registrar; handler not registered");
    return;
  }

  for (const type of CONTENT_TYPES) {
    try {
      const cid = Services.uuid.generateUUID();
      registrar.registerFactory(
        cid as unknown as nsIID,
        `Metalink content handler (${type})`,
        `@mozilla.org/uriloader/content-handler;1?type=${type}`,
        factory,
      );
      registeredCids.push(cid);
    } catch (e) {
      console.error(`[Metalink] could not register handler for ${type}`, e);
    }
  }
}

export function unregisterMetalinkHandler(): void {
  const registrar = getComponentRegistrar();
  if (!registrar) return;
  for (const cid of registeredCids.splice(0)) {
    try {
      registrar.unregisterFactory(cid as unknown as nsIID, factory);
    } catch (e) {
      console.error("[Metalink] unregisterFactory", e);
    }
  }
}

/**
 * Open a Metalink document by URL without going through content handling —
 * used by the RFC 6249 path, where a `rel=describedby` header points at a
 * `.meta4` for a file the user is already downloading.
 */
export function openMetalinkUrl(url: string): Promise<void> {
  return handleMetalinkUri(url);
}

/**
 * Fetch and parse, returning the document instead of broadcasting it.
 *
 * For callers that want the contents without starting anything — the context
 * menu needs the mirror list to build its submenu, and must not kick off a
 * download just by being opened.
 */
export async function readMetalinkUrl(url: string): Promise<MetalinkDocument> {
  return parseMetalink(await fetchMetalinkDocument(url));
}
