/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * CRXConverter - Converts Chrome CRX files to Firefox XPI format
 *
 * This module orchestrates the conversion process:
 * - Parse CRX header and extract ZIP payload
 * - Validate source code for compatibility
 * - Transform manifest.json for Firefox compatibility
 * - Sanitize DNR rules
 * - Repack as XPI file
 *
 * Uses fflate for high-performance ZIP processing
 */

import type {
  ExtensionMetadata,
  ChromeManifest,
  ConversionResult,
  ConversionOptions,
} from "./types.ts";
import { CWSError, CWSErrorCode } from "./types.ts";
import { extractZipFromCRX } from "./CRXParser.sys.mts";
import {
  transformManifest,
  validateManifest,
} from "./ManifestTransformer.sys.mts";
import { sanitizeDNRRules } from "./DNRTransformer.sys.mts";
import {
  validateSourceCode,
  isJavaScriptFile,
  mightContainUnsupportedPatterns,
} from "./CodeValidator.sys.mts";
import { unzipSync, zipSync, type Unzipped } from "fflate/browser";
import { OFFSCREEN_POLYFILL_SOURCE } from "./polyfills/offscreen/OffscreenPolyfillSource.sys.mts";
import { DOCUMENT_ID_POLYFILL_SOURCE } from "./polyfills/documentId/DocumentIdPolyfillSource.sys.mts";
import { PROXY_POLYFILL_SOURCE } from "./polyfills/proxy/ProxyPolyfillSource.sys.mts";
import {
  EXTERNAL_MESSAGING_BACKGROUND_SOURCE,
  EXTERNAL_MESSAGING_BRIDGE_SOURCE,
} from "./polyfills/externalMessaging/ExternalMessagingPolyfillSource.sys.mts";
import { PERMISSIONS_POLYFILL_SOURCE } from "./polyfills/permissions/PermissionsPolyfillSource.sys.mts";

/**
 * Statically expand importScripts calls in converted background scripts.
 *
 * Chrome MV3 backgrounds are workers and load their code with importScripts;
 * Firefox runs the converted background as a page, where that function does
 * not exist. The imported files are listed in the manifest ahead of the
 * caller — preserving execution order — and importScripts itself becomes a
 * shim that throws only for a file that was NOT preloaded, so a dynamic
 * import that this static scan cannot see fails loudly instead of silently.
 *
 * Mutates manifest.background.scripts. Returns the shim's source, or null
 * when no background script calls importScripts.
 */
function expandImportScripts(
  manifest: ChromeManifest,
  files: Unzipped,
): string | null {
  const scripts = manifest.background?.scripts;
  if (!scripts?.length) {
    return null;
  }

  const IMPORT_CALL = /importScripts\s*\(([^)]*)\)/g;
  const STRING_ARG = /["']([^"']+)["']/g;
  const decoder = new TextDecoder();

  const preloaded: string[] = [];
  const expanded: string[] = [];
  const seen = new Set<string>();
  let found = false;

  // Worklist, so a preloaded file's own importScripts is expanded too.
  const expand = (name: string): void => {
    if (seen.has(name)) {
      return;
    }
    seen.add(name);

    const data = files[name];
    const imports: string[] = [];
    if (data) {
      const source = decoder.decode(data);
      for (const call of source.matchAll(IMPORT_CALL)) {
        found = true;
        for (const arg of call[1].matchAll(STRING_ARG)) {
          // Chrome resolves "/js/x.js" against the extension root.
          imports.push(arg[1].replace(/^\//, ""));
        }
      }
    }

    // Imports run before their caller, exactly as importScripts would.
    for (const dep of imports) {
      expand(dep);
      if (!preloaded.includes(dep)) {
        preloaded.push(dep);
      }
    }
    expanded.push(name);
  };

  for (const script of scripts) {
    expand(script);
  }

  if (!found) {
    return null;
  }

  manifest.background!.scripts = [
    "__floorp_polyfills__/ImportScriptsShim.js",
    ...expanded.filter(
      (name, index) => expanded.indexOf(name) === index,
    ),
  ];

  return [
    "// importScripts exists only in workers; this background runs as a page.",
    "// The statically-found imports are loaded by the manifest in call order,",
    "// so the original calls only need to not throw for those files.",
    `var __floorpPreloaded = ${JSON.stringify(preloaded)};`,
    "globalThis.importScripts = function () {",
    "  for (var i = 0; i < arguments.length; i++) {",
    '    var path = String(arguments[i]).replace(/^\\//, "");',
    "    if (__floorpPreloaded.indexOf(path) < 0) {",
    '      throw new Error("[Floorp] importScripts(" + arguments[i] + ") was not statically preloaded");',
    "    }",
    "  }",
    "};",
    "",
  ].join("\n");
}

/**
 * Put a polyfill script into an extension page ahead of its own scripts.
 *
 * It has to be first: patching an API after the page's code has already read
 * it achieves nothing.
 */
function injectPolyfillScript(html: string, polyfillPath: string): string {
  if (html.includes(polyfillPath)) {
    return html;
  }

  const tag = `<script src="/${polyfillPath}"></script>`;

  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }

  const script = /<script[\s>]/i.exec(html);
  if (script) {
    return html.slice(0, script.index) + tag + html.slice(script.index);
  }

  return tag + html;
}

// =============================================================================
// Constants
// =============================================================================

/** Number of files to process before yielding to event loop */
const YIELD_INTERVAL = 50;

/** Default conversion options */
const DEFAULT_OPTIONS: Required<ConversionOptions> = {
  validateCode: true,
  sanitizeDNR: true,
  minGeckoVersion: "115.0",
} as const;

// =============================================================================
// Types
// =============================================================================

interface ProcessZipResult {
  modifiedZip: ArrayBuffer | null;
  originalManifest: ChromeManifest | null;
  warnings: string[];
}

type LogFunction = (step: string) => void;

// =============================================================================
// Utilities
// =============================================================================

/**
 * Yield to the event loop to prevent UI freezing during heavy operations
 * Uses main thread dispatch for proper browser integration
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    Services.tm.dispatchToMainThread(() => resolve());
  });
}

/**
 * Create a logging function with timing information
 * Disabled to reduce console output
 */
function createLogger(): LogFunction {
  return () => {
    // Logging disabled
  };
}

// =============================================================================
// CRXConverter Class
// =============================================================================

/**
 * Converter for Chrome CRX to Firefox XPI format
 */
export class CRXConverterClass {
  private readonly options: Required<ConversionOptions>;

  constructor(options: ConversionOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Convert a CRX file to XPI format
   * @param crxData - Raw CRX file data
   * @param extensionId - Chrome extension ID
   * @param metadata - Extension metadata
   * @returns Conversion result with XPI data or error
   */
  async convert(
    crxData: ArrayBuffer,
    extensionId: string,
    metadata: ExtensionMetadata,
  ): Promise<ConversionResult> {
    const warnings: string[] = [];
    const log = createLogger();

    try {
      log(`Starting conversion for ${extensionId} (${metadata.name})`);

      // Yield before heavy operation
      await yieldToEventLoop();

      // Step 1: Parse CRX header and extract ZIP
      log("Extracting ZIP from CRX...");
      const zipData = extractZipFromCRX(crxData);
      if (!zipData) {
        throw new CWSError(
          CWSErrorCode.INVALID_CRX,
          "Failed to extract ZIP from CRX file",
        );
      }

      log(`Extracted ZIP: ${zipData.byteLength} bytes`);

      // Yield before heavy ZIP processing
      await yieldToEventLoop();

      // Step 2: Parse and transform the manifest using fflate
      log("Processing ZIP contents with fflate...");
      const result = await this.processZipContentsWithFflate(
        zipData,
        extensionId,
        log,
      );
      log("ZIP processing complete");

      if (!result.modifiedZip) {
        // Return original ZIP if modification failed but no error thrown
        log("Could not modify manifest, using original ZIP");
        return {
          success: true,
          xpiData: zipData,
          warnings: [...warnings, ...result.warnings],
        };
      }

      warnings.push(...result.warnings);

      log(
        `Conversion complete. Manifest version: ${result.originalManifest?.manifest_version}`,
      );

      return {
        success: true,
        xpiData: result.modifiedZip,
        originalManifest: result.originalManifest ?? undefined,
        warnings,
      };
    } catch (error) {
      log(`Conversion failed: ${error}`);

      if (error instanceof CWSError) {
        return { success: false, error, warnings };
      }

      return {
        success: false,
        error: new CWSError(
          CWSErrorCode.CONVERSION_FAILED,
          error instanceof Error ? error.message : String(error),
          error,
        ),
        warnings,
      };
    }
  }

  /**
   * Process ZIP contents using fflate for high performance
   */
  private async processZipContentsWithFflate(
    zipData: ArrayBuffer,
    extensionId: string,
    log: LogFunction,
  ): Promise<ProcessZipResult> {
    const warnings: string[] = [];

    // Unzip using fflate
    log("Unzipping with fflate...");
    const zipBytes = new Uint8Array(zipData);
    const unzipped = unzipSync(zipBytes);
    const entryCount = Object.keys(unzipped).length;
    log(`Unzipped ${entryCount} entries`);

    // Yield after unzip
    await yieldToEventLoop();

    // Read manifest.json
    const manifestBytes = unzipped["manifest.json"];
    if (!manifestBytes) {
      throw new CWSError(
        CWSErrorCode.INVALID_MANIFEST,
        "No manifest.json found in extension",
      );
    }

    const manifestContent = new TextDecoder().decode(manifestBytes);

    // Parse and validate manifest
    log("Parsing manifest...");
    const parsedManifest = this.parseManifest(manifestContent);
    if (!parsedManifest) {
      throw new CWSError(
        CWSErrorCode.INVALID_MANIFEST,
        "Invalid manifest.json structure",
      );
    }

    // Transform manifest for Firefox
    log("Transforming manifest for Firefox...");
    const firefoxManifest = transformManifest(parsedManifest, extensionId);
    log("Manifest transformed");

    // Identify DNR rule files
    const dnrRuleFiles = this.identifyDNRRuleFiles(parsedManifest);

    // Yield before processing files
    await yieldToEventLoop();

    // Process and create new ZIP
    log("Creating output XPI...");
    const outputFiles: Unzipped = {};

    // A Chrome service worker pulls its real code in with importScripts, which
    // only exists in workers — Firefox runs the converted background as a
    // page, so without this the call throws and the extension's entire
    // background never runs. The imports are known statically almost always,
    // so they are preloaded via the manifest and importScripts becomes a
    // no-op check.
    const importShim = expandImportScripts(firefoxManifest, unzipped);
    if (importShim) {
      log("Expanding background importScripts...");
      outputFiles["__floorp_polyfills__/ImportScriptsShim.js"] =
        new TextEncoder().encode(importShim);
    }

    // Add transformed manifest
    const manifestJson = JSON.stringify(firefoxManifest, null, 2);
    outputFiles["manifest.json"] = new TextEncoder().encode(manifestJson);

    // Inject Offscreen Polyfill if needed
    if (
      firefoxManifest.background?.scripts?.includes(
        "__floorp_polyfills__/OffscreenPolyfill.js",
      )
    ) {
      log("Injecting Offscreen Polyfill source...");
      outputFiles["__floorp_polyfills__/OffscreenPolyfill.js"] =
        new TextEncoder().encode(OFFSCREEN_POLYFILL_SOURCE);
    }

    // Inject DocumentId Polyfill if needed
    if (
      firefoxManifest.background?.scripts?.includes(
        "__floorp_polyfills__/DocumentIdPolyfill.js",
      )
    ) {
      log("Injecting DocumentId Polyfill source...");
      outputFiles["__floorp_polyfills__/DocumentIdPolyfill.js"] =
        new TextEncoder().encode(DOCUMENT_ID_POLYFILL_SOURCE);
    }

    // Inject Proxy Polyfill if needed
    if (
      firefoxManifest.background?.scripts?.includes(
        "__floorp_polyfills__/ProxyPolyfill.js",
      )
    ) {
      log("Injecting Proxy Polyfill source...");
      outputFiles["__floorp_polyfills__/ProxyPolyfill.js"] =
        new TextEncoder().encode(PROXY_POLYFILL_SOURCE);
    }

    // Inject External Messaging Polyfill if needed. Both halves travel
    // together: the background shim is useless without the page bridge that
    // feeds it, and vice versa.
    if (
      firefoxManifest.background?.scripts?.includes(
        "__floorp_polyfills__/ExternalMessagingPolyfill.js",
      )
    ) {
      log("Injecting External Messaging Polyfill source...");
      outputFiles["__floorp_polyfills__/ExternalMessagingPolyfill.js"] =
        new TextEncoder().encode(EXTERNAL_MESSAGING_BACKGROUND_SOURCE);
      outputFiles["__floorp_polyfills__/ExternalMessagingBridge.js"] =
        new TextEncoder().encode(EXTERNAL_MESSAGING_BRIDGE_SOURCE);
    }

    // Inject Permissions Polyfill if needed
    const needsPermissionsPolyfill = !!firefoxManifest.background?.scripts
      ?.includes("__floorp_polyfills__/PermissionsPolyfill.js");
    if (needsPermissionsPolyfill) {
      log("Injecting Permissions Polyfill source...");
      outputFiles["__floorp_polyfills__/PermissionsPolyfill.js"] =
        new TextEncoder().encode(PERMISSIONS_POLYFILL_SOURCE);
    }

    // Process other files
    let processedCount = 0;
    for (const [filename, data] of Object.entries(unzipped)) {
      if (filename === "manifest.json") {
        continue; // Already added transformed version
      }

      // Validate JavaScript files if enabled
      if (this.options.validateCode && isJavaScriptFile(filename)) {
        const content = new TextDecoder().decode(data);
        if (mightContainUnsupportedPatterns(content)) {
          const error = validateSourceCode(filename, content);
          if (error) {
            throw new CWSError(
              CWSErrorCode.UNSUPPORTED_CODE,
              `${error} in ${filename}`,
            );
          }
        }
      }

      // Sanitize DNR rules if needed
      if (this.options.sanitizeDNR && dnrRuleFiles.has(filename)) {
        try {
          const jsonString = new TextDecoder().decode(data);
          const rules = JSON.parse(jsonString) as unknown[];
          const sanitizedRules = sanitizeDNRRules(rules);
          const sanitizedJson = JSON.stringify(sanitizedRules, null, 2);
          outputFiles[filename] = new TextEncoder().encode(sanitizedJson);
        } catch (e) {
          // Fallback to original with warning
          warnings.push(
            `Failed to sanitize DNR rules in ${filename}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          outputFiles[filename] = data;
        }
      } else if (needsPermissionsPolyfill && filename.endsWith(".html")) {
        // Extension pages call permissions.request too — the popup is
        // usually where the button that asks for it lives — and a page
        // never sees a background script. Give every page the polyfill.
        outputFiles[filename] = new TextEncoder().encode(
          injectPolyfillScript(
            new TextDecoder().decode(data),
            "__floorp_polyfills__/PermissionsPolyfill.js",
          ),
        );
      } else {
        // Copy as-is
        outputFiles[filename] = data;
      }

      processedCount++;

      // Yield periodically to prevent UI freezing
      if (processedCount % YIELD_INTERVAL === 0) {
        await yieldToEventLoop();
      }
    }

    log(`Processed ${processedCount} entries`);

    // Yield before final zip
    await yieldToEventLoop();

    // Create output ZIP using fflate (no compression for speed)
    log("Zipping output XPI with fflate...");
    const outputZip = zipSync(outputFiles, { level: 0 }); // No compression
    log(`Output XPI size: ${outputZip.byteLength} bytes`);

    return {
      modifiedZip: outputZip.buffer as ArrayBuffer,
      originalManifest: parsedManifest,
      warnings,
    };
  }

  /**
   * Identify DNR rule files from manifest
   */
  private identifyDNRRuleFiles(manifest: ChromeManifest): Set<string> {
    const dnrRuleFiles = new Set<string>();
    const dnr = manifest.declarative_net_request;

    if (dnr?.rule_resources) {
      for (const resource of dnr.rule_resources) {
        if (resource.path) {
          const normalizedPath = resource.path.replace(/^\.\//, "");
          dnrRuleFiles.add(normalizedPath);
          dnrRuleFiles.add(resource.path);
        }
      }
    }

    return dnrRuleFiles;
  }

  /**
   * Parse and validate manifest content
   */
  private parseManifest(content: string): ChromeManifest | null {
    try {
      const parsed: unknown = JSON.parse(content);
      if (!validateManifest(parsed)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
}

// =============================================================================
// Legacy API (for backwards compatibility)
// =============================================================================

/**
 * Legacy converter object for backwards compatibility
 */
export const CRXConverter = {
  /**
   * Convert a CRX file to XPI format (async)
   * @deprecated Use CRXConverterClass instead
   */
  async convert(
    crxData: ArrayBuffer,
    extensionId: string,
    metadata: ExtensionMetadata,
  ): Promise<ArrayBuffer | null> {
    const converter = new CRXConverterClass();
    const result = await converter.convert(crxData, extensionId, metadata);

    if (!result.success) {
      if (result.error) {
        throw result.error;
      }
      return null;
    }

    return result.xpiData ?? null;
  },
};
