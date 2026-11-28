import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
const binary = resolve(
  import.meta.dirname,
  "../dist/native/darwin-arm64/KCode Computer Use.app/Contents/MacOS/KCode Computer Use",
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function guard(dir) {
  const child = spawn(binary, ["--lifecycle-guard", dir], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  return { child, output: () => output };
}
async function waitFor(fn) {
  const deadline = Date.now() + 3000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("Native lifecycle guard did not acquire");
    await sleep(10);
  }
}
test(
  "kernel lifecycle lock excludes concurrent starts and releases on guard process death",
  { skip: process.platform !== "darwin" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcua-guard-"));
    const a = guard(dir);
    let b;
    try {
      await waitFor(() => a.output().includes("locked"));
      b = guard(dir);
      await sleep(60);
      assert.equal(b.output(), "");
      a.child.kill("SIGKILL");
      await waitFor(() => b.output().includes("locked"));
      b.child.stdin.end();
      await new Promise((r) => b.child.once("exit", r));
    } finally {
      a.child.kill();
      b?.child.kill();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
