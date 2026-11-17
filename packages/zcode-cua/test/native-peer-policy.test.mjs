import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const exec = promisify(execFile);
test(
  "exact signing leaf, product path and verified Main lineage gate native peers",
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
        resolve(import.meta.dirname, "../native/macos/peer-policy.mm"),
        resolve(import.meta.dirname, "peer-policy-native.mm"),
        "-o",
        out,
      ]);
      assert.match((await exec(out, [])).stdout, /peer policy regressions passed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
