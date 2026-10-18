// SPDX-License-Identifier: MPL-2.0

import * as path from "@std/path";
import { exists, Logger, runCommandChecked, safeRemove } from "./utils.ts";
import { BIN_DIR, PLATFORM } from "./defines.ts";

const logger = new Logger("patcher");

const PATCHES_DIR = "tools/patches";
const PATCHES_TMP = "_dist/bin/applied_patches";

/**
 * A patch set: source dir in the repo + the marker dir in _dist/bin recording
 * what is currently applied. `tools/patches` ships — release packaging replays
 * `_dist/bin/applied_patches` onto every runtime. `tools/patches-dev` changes
 * only the dev runtime in _dist/bin; nothing in tools/release reads its marker.
 */
interface PatchSet {
  dir: string;
  tmp: string;
}

const PATCH_SETS: PatchSet[] = [
  { dir: PATCHES_DIR, tmp: PATCHES_TMP },
  { dir: "tools/patches-dev", tmp: "_dist/bin/applied_dev_patches" },
];
const PLATFORM_PATCH_SUFFIX_RE = /\.(darwin|linux|windows)\.patch$/;

function binDir(): string {
  return BIN_DIR;
}

export function patchAppliesToCurrentPlatform(filename: string): boolean {
  const match = filename.match(PLATFORM_PATCH_SUFFIX_RE);
  if (!match) return true;
  return match[1] === PLATFORM;
}

function listPatchFiles(dir: string): string[] {
  if (!exists(dir)) return [];
  return Array.from(Deno.readDirSync(dir))
    .map((entry) => entry.name)
    .filter((name) =>
      name.endsWith(".patch") && patchAppliesToCurrentPlatform(name)
    )
    .sort();
}

function gitInitialized(dir: string): boolean {
  return exists(path.join(dir, ".git"));
}

export function initializeBinGit(): void {
  const dir = binDir();
  if (gitInitialized(dir)) {
    logger.info("Git repository is already initialized in _dist/bin.");
    return;
  }
  logger.info("Initializing Git repository in _dist/bin.");
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(
    path.join(dir, ".gitignore"),
    [
      "./noraneko-devdir/*",
      "./browser/chrome/browser/res/activity-stream/data/content/abouthomecache/*",
    ].join("\n"),
  );

  let res = runCommandChecked("git", ["init"], dir);
  if (!res.success) throw new Error("Failed to initialize git repo");

  res = runCommandChecked("git", ["add", "."], dir);
  if (!res.success) throw new Error("Failed to add files to git repo");

  res = runCommandChecked("git", ["commit", "-m", "initialize"], dir);
  if (!res.success) throw new Error("Failed to commit initial state");

  logger.success("Git repository initialization complete.");
}

function patchNeeded({ dir, tmp }: PatchSet): boolean {
  if (!exists(dir)) return false;
  if (!exists(tmp)) return true;

  const patchesDirFiles = listPatchFiles(dir);
  const patchesTmpFiles = Array.from(Deno.readDirSync(tmp))
    .map((e) => e.name)
    .filter((name) => patchAppliesToCurrentPlatform(name))
    .sort();

  if (JSON.stringify(patchesDirFiles) !== JSON.stringify(patchesTmpFiles)) {
    return true;
  }

  for (const patch of patchesDirFiles) {
    const patchInDir = Deno.readTextFileSync(path.join(dir, patch));
    const patchInTmp = Deno.readTextFileSync(path.join(tmp, patch));
    if (patchInDir !== patchInTmp) return true;
  }

  return false;
}

function applyPatchSet(set: PatchSet): void {
  const { dir, tmp } = set;
  if (!patchNeeded(set)) {
    logger.info(`No patches needed to apply from ${dir}.`);
    return;
  }

  // Reverse previously applied patches if any
  if (exists(tmp)) {
    logger.info(`Reversing previously applied patches from ${tmp}.`);
    let reverseIsAborted = false;
    const entries = Array.from(Deno.readDirSync(tmp))
      .map((e) => e.name)
      .filter((name) => patchAppliesToCurrentPlatform(name))
      .sort();
    for (const patch of entries) {
      const patchPath = path.join(tmp, patch);
      const result = runCommandChecked(
        "git",
        [
          "apply",
          "-R",
          "--reject",
          "--whitespace=fix",
          "--unsafe-paths",
          "--directory",
          binDir(),
          patchPath,
        ],
        undefined,
      );
      if (!result.success) {
        logger.warn(`Failed to reverse patch: ${patchPath}`);
        logger.warn(result.stderr);
        reverseIsAborted = true;
      }
    }
    if (reverseIsAborted) throw new Error("Reverse Patch Failed: aborted");
    try {
      safeRemove(tmp);
    } catch {
      // ignore
    }
  }

  // Apply new patches
  logger.info(`Applying new patches from ${dir}.`);
  Deno.mkdirSync(tmp, { recursive: true });
  let aborted = false;
  for (const patch of listPatchFiles(dir)) {
    const patchPath = path.join(dir, patch);
    logger.info(`Applying patch: ${patchPath}`);
    const result = runCommandChecked(
      "git",
      [
        "apply",
        "--reject",
        "--whitespace=fix",
        "--unsafe-paths",
        "--directory",
        binDir(),
        patchPath,
      ],
      undefined,
    );
    if (result.success) {
      try {
        Deno.copyFileSync(patchPath, path.join(tmp, patch));
        // deno-lint-ignore no-explicit-any
      } catch (e: any) {
        logger.warn(`Failed to copy patch to tmp: ${e?.message ?? e}`);
        aborted = true;
      }
    } else {
      logger.warn(`Failed to apply patch: ${patchPath}`);
      logger.warn(result.stderr);
      aborted = true;
    }
  }
  if (aborted) throw new Error("Patch failed: aborted");
  logger.success(`All patches from ${dir} applied successfully.`);
}

export function applyPatches(): void {
  for (const set of PATCH_SETS) applyPatchSet(set);
}

export function createPatches(): void {
  initializeBinGit();

  const dir = binDir();
  const stdoutRes = runCommandChecked("git", ["diff", "--name-only"], dir);
  if (!stdoutRes.success) throw new Error("Failed to get changed files");

  const changedFiles = stdoutRes.stdout
    .split("\n")
    .filter((f: string) => f.trim().length > 0);

  if (changedFiles.length === 0) {
    logger.info("No changes detected.");
    return;
  }

  Deno.mkdirSync(PATCHES_DIR, { recursive: true });

  for (const file of changedFiles) {
    const diffRes = runCommandChecked("git", ["diff", file], dir);
    if (!diffRes.success) {
      logger.warn(`Failed to create patch for: ${file}`);
      logger.warn(diffRes.stderr);
      continue;
    }

    const modifiedDiff = diffRes.stdout
      .replace(/^--- a\//gm, "--- ./")
      .replace(/^\+\+\+ b\//gm, "+++ ./")
      .trim() + "\n";

    const patchName = file.replace(/\//g, "-").replace(/\.[^\/.]+$/, "") +
      ".patch";
    const patchPath = path.join(PATCHES_DIR, patchName);
    Deno.writeTextFileSync(patchPath, modifiedDiff);
    logger.info(`Created/Updated patch: ${patchPath}`);
  }
}

export function run(action = "apply"): void {
  switch (action) {
    case "apply":
      applyPatches();
      break;
    case "create":
      createPatches();
      break;
    case "init":
      initializeBinGit();
      break;
    default:
      logger.error(`Unknown patcher action: ${action}`);
  }
}
