import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const exec = promisify(execFile);
test(
  "macOS root IOConsoleLocked and exact console UID determine desktop availability",
  { skip: process.platform !== "darwin" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcua-facts-"));
    try {
      const out = join(dir, "facts");
      await exec("/usr/bin/xcrun", [
        "clang++",
        "-std=c++17",
        "-fobjc-arc",
        "-framework",
        "Foundation",
        resolve(import.meta.dirname, "../native/macos/desktop-facts.mm"),
        resolve(import.meta.dirname, "desktop-facts-native.mm"),
        "-o",
        out,
      ]);
      assert.match((await exec(out, [])).stdout, /regressions passed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test(
  "a locked or unknown desktop keeps the permission_denied screen_locked admission shape",
  { skip: process.platform !== "darwin" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcua-guard-"));
    try {
      const out = join(dir, "guard");
      await exec("/usr/bin/xcrun", [
        "clang++",
        "-std=c++17",
        "-fobjc-arc",
        "-DKCODE_BUILD_ID=\"fixture\"",
        resolve(import.meta.dirname, "../native/macos/permissions.mm"),
        resolve(import.meta.dirname, "../native/macos/desktop-facts.mm"),
        resolve(import.meta.dirname, "../native/macos/protocol-error.mm"),
        resolve(import.meta.dirname, "desktop-guard-native.mm"),
        "-framework",
        "Cocoa",
        "-framework",
        "ApplicationServices",
        "-framework",
        "IOKit",
        "-o",
        out,
      ]);
      assert.match((await exec(out, [])).stdout, /desktop admission regressions passed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
