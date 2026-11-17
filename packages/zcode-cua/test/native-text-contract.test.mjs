import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const exec = promisify(execFile);
test(
  "native string and selection contracts preserve scalars and reject split/decimal ranges",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = resolve(import.meta.dirname, "..");
    const dir = await mkdtemp(join(tmpdir(), "kcua-text-"));
    const binary = join(dir, "text-contract");
    try {
      await exec("xcrun", [
        "clang++",
        "-std=c++17",
        "-fobjc-arc",
        "-fblocks",
        join(root, "native/macos/protocol-error.mm"),
        join(root, "native/macos/text-contract.mm"),
        join(root, "test/text-contract-native.mm"),
        "-framework",
        "Cocoa",
        "-framework",
        "ApplicationServices",
        "-o",
        binary,
      ]);
      const { stdout } = await exec(binary);
      assert.match(stdout, /Unicode, selection boundaries and key chords passed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
