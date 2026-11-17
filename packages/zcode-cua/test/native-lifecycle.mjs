import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const executable = resolve(
  import.meta.dirname,
  "../dist/native/darwin-arm64/KCode Computer Use.app/Contents/MacOS/KCode Computer Use",
);
function exchange(path, requests) {
  return new Promise((resolveResult, reject) => {
    const socket = createConnection(path);
    let buffer = "";
    const replies = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("fixture timeout"));
    }, 3000);
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(requests.map((r) => JSON.stringify(r)).join("\n") + "\n"),
    );
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        replies.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
        if (replies.length === requests.length) {
          clearTimeout(timer);
          socket.destroy();
          resolveResult(replies);
          return;
        }
      }
    });
  });
}
test("source Helper serves legacy authentication and live main-loop health", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kcua-native-"));
  const path = join(dir, "broker.sock");
  const child = spawn(
    executable,
    ["--socket", path, "--allow-unsigned-launcher-local-dev", "--runtime-dir", dir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let errors = "";
  child.stderr.on("data", (c) => {
    errors += c;
  });
  try {
    const deadline = Date.now() + 5000;
    let replies;
    while (Date.now() < deadline) {
      try {
        replies = await exchange(path, [
          { id: 0, method: "authenticate", params: {} },
          { id: 1, method: "broker_info", params: {} },
        ]);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    assert.ok(replies, errors || "no native response");
    assert.equal(replies[0].result.authenticated, true);
    assert.equal(replies[1].result.api_version, "ZCodeComputerUseIPC-1");
    assert.equal(replies[1].result.pid, child.pid);
    assert.equal(replies[1].result.main_loop_responsive, true);
    const rejected = await exchange(path, [
      { id: 0, method: "authenticate", params: { clientApiVersion: 99 } },
    ]);
    assert.equal(rejected[0].error.code, "version_mismatch");
    const noAuth = await exchange(path, [{ id: 1, method: "list_windows", params: {} }]);
    assert.equal(noAuth[0].error.code, "not_authorized");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    await rm(dir, { recursive: true, force: true });
  }
});
