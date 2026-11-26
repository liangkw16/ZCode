import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
const exec = promisify(execFile);

test(
  "observe-only turns start the picture-in-picture preview",
  { skip: process.platform !== "darwin" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcua-pip-session-"));
    const root = resolve(import.meta.dirname, "..");
    const binary = join(dir, "pip-session");
    try {
      await exec("xcrun", [
        "clang++",
        "-std=c++17",
        "-fobjc-arc",
        "-fblocks",
        join(root, "native/macos/presentation.mm"),
        join(root, "native/macos/protocol-error.mm"),
        join(root, "test/pip-session-native.mm"),
        ...["Cocoa", "ApplicationServices", "CoreMedia", "CoreVideo", "ScreenCaptureKit"].flatMap(
          (name) => ["-framework", name],
        ),
        "-o",
        binary,
      ]);
      const { stdout } = await exec(binary, { timeout: 10000 });
      assert.match(stdout, /observe-only turns start the picture-in-picture preview/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
