/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Reads a Metalink document and broadcasts it. No UI, and no interception —
 * MetalinkHttp's response observer is the single place that decides a load is
 * a Metalink and hands it here.
 */

import { parseMetalink, strongestHash } from "./Metalink.sys.mts";
import { fetchMetalinkDocument } from "./MetalinkDownloader.sys.mts";
import type { MetalinkDocument } from "./Metalink.sys.mts";

/** Broadcast when a Metalink document has been parsed and is ready to show. */
export const METALINK_OPEN_TOPIC = "bork-metalink-open";
/** Broadcast when one could not be parsed. */
export const METALINK_ERROR_TOPIC = "bork-metalink-error";

/**
 * notifyObservers takes an nsISupports subject; broadcasting without one is
 * normal and Gecko accepts null, but the generated typings do not model that.
 */
const NO_SUBJECT = null as unknown as nsISupports;

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

/** Read a Metalink at `url` and broadcast it for the chrome layer to act on. */
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
