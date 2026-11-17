import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
const root = fileURLToPath(new URL("..", import.meta.url));
const run = (args) =>
  new Promise((resolveResult) => {
    const child = spawn(process.execPath, args, { cwd: root });
    let output = "";
    child.stdout.on("data", (c) => {
      output += c;
    });
    child.stderr.on("data", (c) => {
      output += c;
    });
    child.on("close", (code) => resolveResult({ code, output }));
  });
test("source producer builds its public protocol without recovery artifacts", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.notEqual(manifest.zcodeCuaPlaceholder, true, "source producer is still a placeholder");
  assert.equal(Object.keys(manifest.exports).length, 12);
  const built = await run(["scripts/build.mjs", "--typescript-only"]);
  assert.equal(built.code, 0, built.output);
  const protocol = await import("../dist/contract/manifest.js");
  assert.equal(new Set(protocol.MODEL_TOOLS).size, 14);
  assert.equal(new Set(protocol.BROKER_METHODS).size, 43);
  assert.equal(protocol.IPC_VERSION, 3);
  for (const item of Object.values(manifest.exports)) {
    await access(resolve(root, item.import));
    await access(resolve(root, item.types));
  }
});
test("native builder rejects an unsupported architecture before compilation", async () => {
  const result = await run(["scripts/build-native.mjs", "--arch", "unsupported"]);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Unsupported architecture/);
});
