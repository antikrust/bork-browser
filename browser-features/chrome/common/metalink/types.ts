/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type {
  MetalinkDocument,
  MetalinkFile,
  MetalinkHash,
  MetalinkUrl,
} from "#modules/modules/Metalink.sys.mts";

export type { MetalinkDocument, MetalinkFile, MetalinkHash, MetalinkUrl };

/** Payload of the bork-metalink-open notification, as JSON. */
export interface MetalinkOpenPayload {
  sourceUrl: string;
  document: MetalinkDocument;
  suggested: {
    fileIndex: number;
    hashType?: string;
  };
}

export interface MetalinkErrorPayload {
  sourceUrl: string;
  error: string;
}

/** The pure-parsing half of the ESM layer. */
export interface MetalinkModule {
  orderMirrors(file: MetalinkFile, preferredLocation?: string): MetalinkUrl[];
  strongestHash(file: MetalinkFile): MetalinkHash | undefined;
}

export interface MetalinkServiceModule {
  openMetalinkUrl(url: string): Promise<void>;
  readMetalinkUrl(url: string): Promise<MetalinkDocument>;
}

export interface SegmentedResult {
  ok: boolean;
  path?: string;
  verified: boolean;
  hashType?: string;
  contributions: Record<string, number>;
  retiredMirrors: string[];
  error?: string;
  fellBackToSingle?: boolean;
  cancelled?: boolean;
}

export interface MetalinkDownloadDetails {
  mirrorCount: number;
  usedMirrors: number;
  verified: boolean;
  hashType?: string;
}

export interface MetalinkIntegrationModule {
  startSegmentedDownload(
    file: MetalinkFile,
    mirrors: MetalinkUrl[],
    hash: MetalinkHash | undefined,
    targetPath: string,
  ): Promise<{
    download: object;
    completion: Promise<SegmentedResult | null>;
  }>;
  isMetalinkDownload(download: object): boolean;
  metalinkDetails(download: object): MetalinkDownloadDetails | undefined;
}

export interface MetalinkSegmentedModule {
  downloadSegmented(
    file: MetalinkFile,
    mirrors: MetalinkUrl[],
    hash: MetalinkHash | undefined,
    targetPath: string,
    onProgress?: (p: {
      receivedBytes: number;
      totalBytes: number;
      activeMirrors: string[];
      completedChunks: number;
      totalChunks: number;
    }) => void,
  ): Promise<SegmentedResult>;
}

export interface MetalinkAttempt {
  url: string;
  ok: boolean;
  reason?: string;
}

export interface MetalinkDownloadResult {
  ok: boolean;
  cancelled?: boolean;
  path?: string;
  mirror?: string;
  verified: boolean;
  hashType?: string;
  attempts: MetalinkAttempt[];
  error?: string;
}

export interface MetalinkDownloaderModule {
  downloadMetalinkFile(
    file: MetalinkFile,
    mirrors: MetalinkUrl[],
    hash: MetalinkHash | undefined,
    onProgress?: (mirror: string, index: number, total: number) => void,
  ): Promise<MetalinkDownloadResult>;
  targetPathFor(name: string): Promise<string>;
}
