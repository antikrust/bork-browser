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
 * bork ships NO enterprise policies. Any active policy — even one line —
 * makes every profile show "Your browser is being managed by your
 * organisation" in settings, which reads as spyware on a personal browser.
 * What policies.json used to carry moved to mechanisms that do not trip the
 * banner:
 *  - default search engine -> distribution/distribution.ini ([Global] +
 *    searchDefault), the classic distro mechanism;
 *  - DisableAppUpdate -> nothing. The runtime's compiled-in update URL is
 *    Mozilla's aus5 server, which does not serve this product, so Mozilla's
 *    checker finds nothing by itself; updates are bork's own check
 *    (NoranekoUpdateChecker reads updates/update.xml from the repo).
 *    override.ini sets app.update.auto = false so it never even tries a
 *    background download.
 * Default add-ons (uBO, Dark Reader, the theme pack) install from
 * distribution/extensions as ordinary user-removable add-ons.
 */
/**
 * The version field surfaces in user-visible places (the About dialog and
 * settings both render "distribution.id — distribution.version"), so it
 * carries the real shipping version from the root package.json — a hardcoded
 * placeholder here had users reading "bork — 1.0" on a 1.1.6 install.
 */
function distributionIni(): string {
  let version = "0.0.0";
  try {
    version = (JSON.parse(
      Deno.readTextFileSync(path.join(PROJECT_ROOT, "package.json")),
    ) as { version?: string }).version ?? version;
  } catch {
    // keep the placeholder; a broken package.json fails the build elsewhere
  }
  return [
    "[Global]",
    "id=bork",
    `version=${version}`,
    "about=bork",
    "",
    "[Preferences]",
    "",
    "[Search]",
    "searchDefault=DuckDuckGo",
    "",
  ].join("\n");
}

/**
 * Zip a WebExtension source directory to <extDir>/<gecko-id>.xpi.
 *
 * The add-on id has to be the FILENAME — that is how Firefox matches a
 * distribution add-on to what it installs — so it is read from the manifest
 * rather than taken from the directory name, which nothing enforces.
 *
 * @returns the gecko id on success, or null when the directory is not a
 *   packable extension (no manifest, no id) or zip failed.
 */
function packExtensionDir(
  dir: string,
  extDir: string,
  exclude: string[] = [],
): string | null {
  const manifestPath = path.join(dir, "manifest.json");
  if (!exists(manifestPath)) return null;

  // Parse failures stay local to this extension. This ran inside the caller's
  // try once, and one truncated manifest.json aborted the whole pack loop —
  // every add-on after it silently missing from a shipped release.
  let manifest: {
    version?: string;
    browser_specific_settings?: { gecko?: { id?: string } };
  };
  try {
    manifest = JSON.parse(Deno.readTextFileSync(manifestPath));
  } catch (e) {
    logger.error(`${path.basename(dir)}: unreadable manifest.json: ${e}`);
    return null;
  }
  const id = manifest.browser_specific_settings?.gecko?.id;
  if (!id) {
    logger.warn(`${path.basename(dir)}: no gecko id, skipped`);
    return null;
  }

  const xpi = path.join(extDir, `${id}.xpi`);
  safeRemove(xpi);

  // Prefer a signed build of this exact version. bork does not require
  // signatures, but an unsigned add-on wears a "could not be verified" badge
  // in about:addons, and shipping the same file the website hands out means
  // one artifact rather than a signed and an unsigned twin.
  const signed = signedArtifact(dir, manifest.version);
  if (signed) {
    Deno.copyFileSync(signed, xpi);
    logger.info(`${path.basename(dir)}: shipped the signed ${manifest.version}`);
    return id;
  }

  // Contents at archive root (manifest.json top-level), no extras.
  const args = ["-r", "-X", "-q", xpi, "."];
  if (exclude.length) args.push("-x", ...exclude);

  const result = runCommandChecked("zip", args, dir);
  if (!result.success) {
    logger.error(`${path.basename(dir)}: zip failed: ${result.stderr}`);
    return null;
  }
  return id;
}

/**
 * Signed artifacts by extension directory name. These are what the website
 * hands out, produced by tools/release/sign-extension.sh; the filenames differ
 * from the directory names because they are public download URLs.
 */
const SIGNED_XPI: Record<string, string> = {
  shutup: "tools/release/site/shut-up.xpi",
};

/**
 * A Mozilla-signed xpi for this extension at this version, if one has been
 * produced by tools/release/sign-extension.sh.
 *
 * Version-matched deliberately: a signed artifact one version behind the
 * source is the wrong code, so it is ignored and the source is packed instead
 * (unsigned, which bork accepts) rather than silently shipping stale files.
 */
function signedArtifact(dir: string, version?: string): string | null {
  if (!version) return null;
  const relative = SIGNED_XPI[path.basename(dir)];
  if (!relative) return null;

  const candidate = path.join(PROJECT_ROOT, relative);
  if (!exists(candidate)) return null;

  const check = runCommandChecked("unzip", ["-p", candidate, "manifest.json"]);
  if (!check.success) return null;
  try {
    const signedManifest = JSON.parse(check.stdout);
    if (signedManifest.version !== version) {
      logger.warn(
        `${path.basename(dir)}: signed xpi is ${signedManifest.version}, source is ${version} — packing source unsigned`,
      );
      return null;
    }
  } catch {
    return null;
  }
  return candidate;
}

/** Repo sources that belong to the extension, not to the shipped add-on. */
const EXTENSION_PACK_EXCLUDES = ["test/*", "*.md", "build.sh", ".gitignore"];

/**
 * bork add-on pack: the static WebExtension themes in browser-features/themes/
 * are zipped into <app>/distribution/extensions/<gecko-id>.xpi, and everything
 * in browser-features/extensions/ joins them — third-party add-ons vendored as
 * .xpi files named by their gecko id (uBlock Origin, Dark Reader) are copied
 * across, and our OWN extensions, which live there as source directories, are
 * zipped on every build.
 *
 * Our own ones are kept as source rather than a checked-in .xpi deliberately: a
 * built artifact in the tree is one nobody can date, which is how deleted
 * add-ons kept shipping for four days after they were removed from this file.
 * Firefox auto-installs everything in that directory into new profiles as
 * ordinary add-ons: user-visible in about:addons, user-removable, no policy
 * machinery involved. The runtime does not enforce add-on signing, so plain
 * zips are enough for the themes.
 */
export function installThemePack(): void {
  const themesSrc = path.join(PROJECT_ROOT, "browser-features", "themes");
  if (!exists(themesSrc)) return;
  const extDir = path.join(BIN_DIR, "distribution", "extensions");
  try {
    // Clear first, don't just overwrite what we are about to write. This
    // directory is copied wholesale into every package, so an .xpi whose theme
    // was renamed or deleted lingers forever and ships: the 10 pre-rebrand
    // `@themes.derp` files were still going out alongside their `@themes.bork`
    // replacements, doubling the preinstalled theme list.
    safeRemove(extDir);
    Deno.mkdirSync(extDir, { recursive: true });
    let count = 0;
    for (const entry of Deno.readDirSync(themesSrc)) {
      if (!entry.isDirectory) continue;
      if (packExtensionDir(path.join(themesSrc, entry.name), extDir)) count++;
    }
    let bundled = 0;
    const bundledSrc = path.join(PROJECT_ROOT, "browser-features", "extensions");
    if (exists(bundledSrc)) {
      for (const entry of Deno.readDirSync(bundledSrc)) {
        if (entry.isFile && entry.name.endsWith(".xpi")) {
          // Third-party add-ons, shipped exactly as their authors built them.
          Deno.copyFileSync(
            path.join(bundledSrc, entry.name),
            path.join(extDir, entry.name),
          );
          bundled++;
          continue;
        }
        if (!entry.isDirectory) continue;
        const packed = packExtensionDir(
          path.join(bundledSrc, entry.name),
          extDir,
          EXTENSION_PACK_EXCLUDES,
        );
        if (packed) bundled++;
      }
    }
    logger.success(
      `add-on pack: ${count} themes + ${bundled} extensions → distribution/extensions`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`Failed to build add-on pack: ${msg}`);
  }
}

export function installDistributionPolicies(): void {
  const distDir = path.join(BIN_DIR, "distribution");
  try {
    Deno.mkdirSync(distDir, { recursive: true });
    Deno.writeTextFileSync(
      path.join(distDir, "distribution.ini"),
      distributionIni(),
    );
    // An old policies.json in the build tree would still ship and still trip
    // the "managed by your organisation" banner — remove, never carry.
    safeRemove(path.join(distDir, "policies.json"));
    logger.success("distribution/distribution.ini written (no policies)");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`Failed to write distribution config: ${msg}`);
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
