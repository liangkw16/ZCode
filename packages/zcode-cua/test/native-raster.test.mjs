import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const exec = promisify(execFile);
test(
  "native raster fits the existing inline budget before authority issuance",
  { skip: process.platform !== "darwin" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcua-raster-"));
    const root = resolve(import.meta.dirname, "..");
    const binary = join(dir, "raster");
    try {
      await exec("xcrun", [
        "clang++",
        "-std=c++17",
        "-fobjc-arc",
        "-fblocks",
        "-DKCODE_INLINE_FRAME_BYTES=153600",
        join(root, "native/macos/raster-encoding.mm"),
        join(root, "native/macos/protocol-error.mm"),
        join(root, "test/raster-encoding-native.mm"),
        "-framework",
        "Cocoa",
        "-framework",
        "CoreGraphics",
        "-o",
        binary,
      ]);
      const { stdout } = await exec(binary, { timeout: 10000 });
      assert.match(stdout, /raster budget and immutable small PNG passed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
