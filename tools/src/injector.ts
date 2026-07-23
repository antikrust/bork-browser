// SPDX-License-Identifier: MPL-2.0

import * as path from "@std/path";
import {
  runCommandChecked,
  Logger,
  exists,
  safeRemove,
  createSymlink,
} from "./utils.ts";
import { BIN_DIR, PROD_BIN_DIR, PROJECT_ROOT } from "./defines.ts";

const logger = new Logger("injector");

/**
 * bork: default extension pack, delivered via the enterprise-policy file the
 * browser reads from <app>/distribution/policies.json. "normal_installed"
 * auto-installs on first run (downloaded from AMO) but stays user-removable.
 */
const DEFAULT_POLICIES = {
  policies: {
    SearchEngines: {
      Default: "DuckDuckGo",
    },
    // The runtime's compiled-in update URL is Mozilla's aus5 server, which
    // doesn't serve this product — every check is a no-op ping. Updates are
    // bork's own check instead (chrome/common/update-check reads
    // updates/update.xml from the repo's main branch).
    DisableAppUpdate: true,
    // Blocking is uBlock Origin alone: Ghostery and Privacy Badger were
    // ~wholly redundant on top of it (Ghostery's one distinct feature,
    // consent auto-reject, is covered natively — bork-defaults enables
    // cookiebanners.service.mode 1). Fewer defaults, fewer "which blocker
    // broke this site" mysteries.
    ExtensionSettings: {
      "uBlock0@raymondhill.net": {
        installation_mode: "normal_installed",
        install_url:
          "https://addons.mozilla.org/firefox/downloads/latest/ublock-origin/latest.xpi",
      },
      "addon@darkreader.org": {
        installation_mode: "normal_installed",
        install_url:
          "https://addons.mozilla.org/firefox/downloads/latest/darkreader/latest.xpi",
      },
    },
  },
};

/**
 * bork theme pack: the static WebExtension themes in browser-features/themes/
 * are zipped into <app>/distribution/extensions/<gecko-id>.xpi, which Firefox
 * auto-installs into new profiles (user-visible in about:addons, removable).
 * The runtime does not enforce add-on signing, so plain zips are enough.
 */
export function installThemePack(): void {
  const themesSrc = path.join(PROJECT_ROOT, "browser-features", "themes");
  if (!exists(themesSrc)) return;
  const extDir = path.join(BIN_DIR, "distribution", "extensions");
  try {
    Deno.mkdirSync(extDir, { recursive: true });
    let count = 0;
    for (const entry of Deno.readDirSync(themesSrc)) {
      if (!entry.isDirectory) continue;
      const dir = path.join(themesSrc, entry.name);
      const manifestPath = path.join(dir, "manifest.json");
      if (!exists(manifestPath)) continue;
      const manifest = JSON.parse(Deno.readTextFileSync(manifestPath)) as {
        browser_specific_settings?: { gecko?: { id?: string } };
      };
      const id = manifest.browser_specific_settings?.gecko?.id;
      if (!id) {
        logger.warn(`theme ${entry.name}: no gecko id, skipped`);
        continue;
      }
      const xpi = path.join(extDir, `${id}.xpi`);
      safeRemove(xpi);
      // Zip contents at archive root (manifest.json top-level), no extras.
      const result = runCommandChecked("zip", ["-r", "-X", "-q", xpi, "."], dir);
      if (!result.success) {
        logger.error(`theme ${entry.name}: zip failed: ${result.stderr}`);
        continue;
      }
      count++;
    }
    logger.success(`theme pack: ${count} themes → distribution/extensions`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`Failed to build theme pack: ${msg}`);
  }
}

export function installDistributionPolicies(): void {
  const distDir = path.join(BIN_DIR, "distribution");
  try {
    Deno.mkdirSync(distDir, { recursive: true });
    Deno.writeTextFileSync(
      path.join(distDir, "policies.json"),
      JSON.stringify(DEFAULT_POLICIES, null, 2),
    );
    logger.success("distribution/policies.json written (default extensions)");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`Failed to write distribution policies: ${msg}`);
  }
}

export async function injectXhtmlFromTs(
  isDev = false,
  isCI = false,
): Promise<void> {
  const scriptPath = path.join(PROJECT_ROOT, "tools", "scripts", "xhtml.ts");
  let binPath = !isCI ? BIN_DIR : PROD_BIN_DIR;

  // In CI, the default PROJECT_ROOT is incorrect because scripts run from a subdir.
  // We must manually construct the correct path to the build artifacts.
  if (isCI) {
    // The real project root in CI is one level above the script's calculated PROJECT_ROOT.
    const ciProjectRoot = path.resolve(PROJECT_ROOT, "..");
    const distDir = path.join(
      ciProjectRoot,
      "obj-artifact-build-output",
      "dist",
    );

    const canonPlatform = Deno.env.get("CANON_PLATFORM");
    if (canonPlatform === "macOS-x86_64") {
      let appBundleFound = false;
      try {
        for await (const dirEntry of Deno.readDir(distDir)) {
          if (dirEntry.isDirectory && dirEntry.name.endsWith(".app")) {
            binPath = path.join(
              distDir,
              dirEntry.name,
              "Contents",
              "Resources",
            );
            appBundleFound = true;
            logger.info(
              `Found macOS app bundle, setting binPath to: ${binPath}`,
            );
            break;
          }
        }
      } catch (e: unknown) {
        logger.warn(
          `Could not read dist directory ${distDir} for macOS .app bundle search: ${e instanceof Error ? e.message : e}`,
        );
      }
      if (!appBundleFound) {
        logger.warn(
          `macOS platform detected, but no .app bundle found in ${distDir}. Using default PROD_BIN_DIR.`,
        );
        // The default PROD_BIN_DIR is also relative to the wrong root, so we construct an absolute path.
        binPath = path.join(distDir, "bin");
      }
    } else {
      // For non-macOS CI builds, the path is obj-artifact-build-output/dist/bin
      binPath = path.join(distDir, "bin");
      logger.info(`CI platform detected, setting binPath to: ${binPath}`);
    }
  }

  const args = ["run", "--allow-read", "--allow-write", scriptPath, binPath];
  if (isDev) args.push("--dev");

  const result = runCommandChecked("deno", args);
  if (!result.success) {
    throw new Error(`Failed to inject XHTML: ${result.stderr}`);
  }
  logger.success("XHTML injection complete.");
  // Keep function legitimately async to match callers that await it
  // and satisfy the lint rule requiring at least one await.
  await Promise.resolve();
}

export function createManifest(mode: string, dirPath: string) {
  let manifestContent = [
    "content noraneko content/ contentaccessible=yes",
    "content noraneko-startup startup/ contentaccessible=yes",
    "content noraneko-skin skin/ contentaccessible=yes",
    "content noraneko-help help/ contentaccessible=yes",
    "resource noraneko resource/ contentaccessible=yes",
    "content noraneko-pages-aboutdialog pages-aboutDialog/ contentaccessible=yes",
    "override chrome://browser/content/aboutDialog.xhtml chrome://noraneko-pages-aboutdialog/content/aboutDialog.html",
  ].join("\n");

  // if (dev) the pages should be served in vite dev server
  // stage and productions needs static contents
  if (mode !== "dev") {
    const devEntries = [
      "content noraneko-newtab pages-newtab/ contentaccessible=yes",
      "content noraneko-welcome pages-welcome/ contentaccessible=yes",
      "content noraneko-notes pages-notes/ contentaccessible=yes",
      "content noraneko-modal-child pages-modal-child/ contentaccessible=yes",
      "content noraneko-profile-manager pages-profile-manager/ contentaccessible=yes",
    ].join("\n");
    manifestContent += "\n" + devEntries;
  }

  Deno.writeTextFileSync(
    path.join(dirPath, "noraneko.manifest"),
    manifestContent,
  );
}

/**
 * This creates chrome.manifest, and symlinks the dists to firefox binary dir.
 * for production, only symlinks will be created.
 * @param mode
 * @param dirName
 */
export function run(mode: string, dirName = "noraneko-devdir"): void {
  const manifestPath = path.join(BIN_DIR, "chrome.manifest");

  if (mode === "dev" || mode === "stage") {
    let manifest = "";
    if (exists(manifestPath)) {
      manifest = Deno.readTextFileSync(manifestPath);
    }
    const entry = `manifest ${dirName}/noraneko.manifest`;
    if (!manifest.includes(entry)) {
      Deno.writeTextFileSync(manifestPath, `${manifest}\n${entry}`);
    }
  }

  const dirPath = path.join(BIN_DIR, dirName);
  try {
    if (exists(dirPath)) {
      safeRemove(dirPath);
    }
    Deno.mkdirSync(dirPath, { recursive: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`Failed to prepare directory ${dirPath}: ${msg}`);
    throw e;
  }

  createManifest(mode, dirPath);
  installDistributionPolicies();
  installThemePack();

  const mounts: Array<[string, string]> = [
    ["content", "bridge/loader-features/_dist"],
    ["startup", "bridge/startup/_dist"],
    ["skin", "browser-features/skin"],
    // Static HTML help pages, served straight from source like the skin.
    ["help", "browser-features/help"],
    ["resource", "bridge/loader-modules/_dist"],
    ["pages-newtab", "browser-features/pages-newtab/_dist"],
    ["pages-welcome", "browser-features/pages-welcome/_dist"],
    ["pages-notes", "browser-features/pages-notes/_dist"],
    ["pages-modal-child", "browser-features/pages-modal-child/_dist"],
    ["pages-profile-manager", "browser-features/pages-profile-manager/_dist"],
    ["pages-aboutDialog", "browser-features/pages-aboutDialog/_dist"],
  ];

  for (const [subdir, target] of mounts) {
    const linkPath = path.resolve(dirPath, subdir);
    const targetPath = path.resolve(target);
    try {
      if (exists(linkPath)) {
        safeRemove(linkPath);
      }
    } catch {
      // ignore
    }

    try {
      createSymlink(linkPath, targetPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(
        `Failed to create symlink ${linkPath} -> ${targetPath}: ${msg}`,
      );
    }
  }

  logger.success("Manifest injected successfully.");
}
