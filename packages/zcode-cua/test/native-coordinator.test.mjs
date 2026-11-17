import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const exec = promisify(execFile);
test(
  "native coordinator drains before ACK and bounds a stalled operation without replay",
  { skip: process.platform !== "darwin", timeout: 20000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcua-test-build-"));
    const binary = join(dir, "coordinator");
    const root = resolve(import.meta.dirname, "..");
    try {
      await exec("xcrun", [
        "clang++",
        "-std=c++17",
        "-fobjc-arc",
        "-fblocks",
        '-DKCODE_BUILD_ID="fixture"',
        join(root, "native/macos/coordinator.mm"),
        join(root, "native/macos/protocol-error.mm"),
        join(root, "test/cancellation-native.mm"),
        "-framework",
        "Cocoa",
        "-o",
        binary,
      ]);
      const normal = await exec(binary, [], { timeout: 3000 });
      assert.match(normal.stdout, /continuation and session isolation passed/);
      const leaseModes = [
        ["--legacy-cancel", /continuation and session isolation passed/],
        ["--peer-death", /dead peer scope drained and lease released/],
        ["--lease-reclaim", /dead lease reclaimer recovered/],
        ["--lease-release", /last scope releases physical controller lease/],
      ];
      const leaseResults = await Promise.allSettled(
        leaseModes.map(async ([mode, expected]) =>
          assert.match((await exec(binary, [mode], { timeout: 3000 })).stdout, expected),
        ),
      );
      assert.ok(
        leaseResults.every((r) => r.status === "fulfilled"),
        leaseResults
          .map((r, i) =>
            r.status === "rejected"
              ? `${leaseModes[i][0]}: ${r.reason.stderr ?? r.reason.message}`
              : "passed",
          )
          .join("\n"),
      );
      const start = performance.now();
      await assert.rejects(
        exec(binary, ["--stall"], { timeout: 10000 }),
        (error) => error.code === 75 && error.killed === false,
      );
      assert.ok(performance.now() - start < 9500, "stall recovery exceeded its 5s + 3s budget");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
