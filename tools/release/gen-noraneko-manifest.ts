// SPDX-License-Identifier: MPL-2.0
// Writes noraneko.manifest into the given noraneko content dir using the
// same createManifest the build system owns (no drift with injector.ts).
import { createManifest } from "../src/injector.ts";

const dir = Deno.args[0];
if (!dir) {
  console.error("usage: gen-noraneko-manifest.ts <noraneko-dir>");
  Deno.exit(1);
}
createManifest("production", dir);
console.log(`manifest written: ${dir}/noraneko.manifest`);
