// SPDX-License-Identifier: MPL-2.0

import { assertEquals } from "@std/assert";
import { writeBuildid2, readBuildid2 } from "./update.ts";
import * as path from "@std/path";

Deno.test("writeBuildid2 and readBuildid2 round-trip", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const filePath = path.join(tmpDir, "buildid2.txt");
    writeBuildid2(filePath, "20260401120000");
    const result = readBuildid2(filePath);
    assertEquals(result, "20260401120000");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});

Deno.test("readBuildid2 returns null for non-existent file", () => {
  const result = readBuildid2("/tmp/nonexistent_buildid2_file_" + Date.now());
  assertEquals(result, null);
});

Deno.test("writeBuildid2 creates parent directories", () => {
  const tmpDir = Deno.makeTempDirSync();
  try {
    const filePath = path.join(tmpDir, "nested", "dir", "buildid2.txt");
    writeBuildid2(filePath, "test-id");
    const result = readBuildid2(filePath);
    assertEquals(result, "test-id");
  } finally {
    Deno.removeSync(tmpDir, { recursive: true });
  }
});
