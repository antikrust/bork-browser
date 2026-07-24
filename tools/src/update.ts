// SPDX-License-Identifier: MPL-2.0

import * as path from "@std/path";
import { runCommandChecked, exists } from "./utils.ts";
import { PROJECT_ROOT } from "./defines.ts";

export function writeVersion(geckoDir: string): void {
  const pkgPath = path.join(PROJECT_ROOT, "package.json");
  const pkg = JSON.parse(Deno.readTextFileSync(pkgPath));
  const version = pkg.version;
  const configDir = path.join(geckoDir, "config");
  Deno.mkdirSync(configDir, { recursive: true });
  ["version.txt", "version_display.txt"].forEach((file) => {
    Deno.writeTextFileSync(path.join(configDir, file), String(version));
  });
  console.log(`[update] Version files written to ${configDir}`);
}

export function writeBuildid2(pathBuildid2: string, buildid2: string): void {
  const dir = path.dirname(pathBuildid2);
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(pathBuildid2, buildid2);
  console.log(`[update] Build ID written to ${pathBuildid2}`);
}

export function readBuildid2(pathBuildid2: string): string | null {
  if (!exists(pathBuildid2)) return null;
  return Deno.readTextFileSync(pathBuildid2).trim();
}

export function generateUuidV7(): string {
  const scriptPath = path.join(PROJECT_ROOT, "tools", "scripts", "gen-uuid.ts");
  const res = runCommandChecked("deno", ["run", "--allow-net", scriptPath]);
  if (!res.success) {
    throw new Error(`Failed to generate UUIDv7: ${res.stderr}`);
  }
  console.log(res.stdout.trim());
  return res.stdout.trim();
}

