import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exec = promisify(execFile);

// 夹具把 observation.mm 并入自己的编译单元（重定位与遍历都是文件内静态函数），所以这里不单独
// 编译它。
async function runObservationFixture(name, fixture, expected) {
  const root = resolve(import.meta.dirname, "..");
  const dir = await mkdtemp(join(tmpdir(), "kcua-observation-"));
  const binary = join(dir, name);
  try {
    await exec("xcrun", [
      "clang++",
      "-std=c++17",
      "-fobjc-arc",
      "-fblocks",
      join(root, `test/${fixture}`),
      join(root, "native/macos/text-contract.mm"),
      join(root, "native/macos/protocol-error.mm"),
      "-framework",
      "Cocoa",
      "-framework",
      "ApplicationServices",
      "-o",
      binary,
    ]);
    const { stdout } = await exec(binary, { timeout: 15000 });
    assert.match(stdout, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test(
  "observing web content requests pending updates before reading values",
  { skip: process.platform !== "darwin", timeout: 60000 },
  async () => {
    await runObservationFixture(
      "observe-web",
      "observe-web-native.mm",
      /observing web content requests pending updates before reading values/,
    );
  },
);
test(
  "element refetch resolves only a unique match from a completed window search",
  { skip: process.platform !== "darwin", timeout: 60000 },
  async () => {
    await runObservationFixture(
      "element-refetch",
      "element-refetch-native.mm",
      /element refetch resolves only a unique match from a completed search/,
    );
  },
);
