import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exec = promisify(execFile);
test("normal and cancelled input release stay bound to the original window", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = resolve(import.meta.dirname, "..");
  const dir = await mkdtemp(join(tmpdir(), "kcua-release-"));
  const binary = join(dir, "input-release");
  try {
    await exec("xcrun", [
      "clang++", "-std=c++17", "-fobjc-arc", "-fblocks",
      ...["input.mm", "protocol-error.mm", "text-contract.mm"].map((name) =>
        join(root, "native/macos", name),
      ),
      join(root, "test/input-release-native.mm"),
      "-framework", "Cocoa", "-framework", "ApplicationServices", "-o", binary,
    ]);
    const { stdout } = await exec(binary, { timeout: 10000 });
    assert.match(stdout, /targeted normal and cancelled release passed/);
    await assert.rejects(exec(binary, ["crash-down", dir]), { code: 75 });
    const recovered = await exec(binary, ["recover", dir]);
    assert.match(recovered.stdout, /original window before new input/);
    await assert.rejects(readFile(join(dir, "input-safety.plist")), { code: "ENOENT" });
    await assert.rejects(exec(binary, ["crash-up", dir]), { code: 75 });
    const previous = await readFile(join(dir, "input-safety.plist"));
    const unresolved = await exec(binary, ["unresolved", dir]);
    assert.match(unresolved.stdout, /stayed unresolved/);
    assert.deepEqual(await readFile(join(dir, "input-safety.plist")), previous);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
