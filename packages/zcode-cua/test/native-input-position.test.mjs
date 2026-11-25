import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exec = promisify(execFile);
const darwin = { skip: process.platform !== "darwin" };

async function runFixture(name, fixture, expected) {
  const root = resolve(import.meta.dirname, "..");
  const dir = await mkdtemp(join(tmpdir(), "kcua-input-"));
  const binary = join(dir, name);
  try {
    await exec("xcrun", [
      "clang++", "-std=c++17", "-fobjc-arc", "-fblocks",
      ...["input.mm", "protocol-error.mm", "text-contract.mm"].map((file) =>
        join(root, "native/macos", file),
      ),
      join(root, `test/${fixture}`),
      "-framework", "Cocoa", "-framework", "ApplicationServices", "-o", binary,
    ]);
    const { stdout } = await exec(binary, { timeout: 15000 });
    assert.match(stdout, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("typing positioning focuses or clicks inside one native operation and rejects foreign targets", darwin, async () => {
  await runFixture(
    "input-position",
    "input-position-native.mm",
    /typing positioning stays inside one native operation/,
  );
});

test("paste transaction keeps concurrent clipboard writes and restores its own takeover", darwin, async () => {
  await runFixture(
    "paste-transaction",
    "paste-transaction-native.mm",
    /paste transaction keeps concurrent clipboard writes/,
  );
});

test("paste receipt reports a focused field that never received the text", darwin, async () => {
  await runFixture(
    "text-landing",
    "text-landing-native.mm",
    /paste receipt reports a focused field that never received the text/,
  );
});
