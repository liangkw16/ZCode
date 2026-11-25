import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, cp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProductCuaHelperHost } from "../dist/adapters/helper-host.js";
import { createComputerUseRuntime } from "../dist/adapters/runtime-factory.js";
import { createBrokerClient } from "../dist/adapters/broker-client.js";
import { resolveBrokerSocketPath } from "../dist/adapters/socket-path.js";
import { findLiveHelper, retireProcess } from "../dist/adapters/process-identity.js";
import {
  CUA_REQUEST_ACCESS_STATUS_META_KEY,
  cuaRequestAccessStatusSchema,
} from "../request-access-contract.js";
const sourceApp = resolve(
  import.meta.dirname,
  "../dist/native/darwin-arm64/KCode Computer Use.app",
);
const exec = promisify(execFile);
async function developmentApp(dir) {
  const app = join(dir, "KCode Computer Use.app");
  await cp(sourceApp, app, { recursive: true });
  const path = join(app, "Contents/Resources/source-manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.signing = "development-adhoc";
  await writeFile(path, JSON.stringify(manifest));
  // 工程 Node 不冒充签名 Main；仅在独立副本启用显式开发策略，发布产物保持原签名。
  await exec("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
  return app;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function cleanupHelper(app) {
  const binary = join(app, "Contents/MacOS/KCode Computer Use");
  const identity = await findLiveHelper(binary, binary);
  if (identity) await retireProcess(binary, identity);
}
test(
  "two real Hosts share one source Helper across concurrent cold start and stop/start",
  { skip: process.platform !== "darwin", timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcua-host-live-"));
    const app = await developmentApp(dir);
    const env = {
      ...process.env,
      XDG_RUNTIME_DIR: dir,
      ZCODE_CUA_PERMISSION_BROKER_SOCKET: undefined,
      ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1",
    };
    const make = () =>
      createProductCuaHelperHost({
        env,
        bundledHelperAppPath: app,
        helperInstaller: {
          async ensureInstalled() {
            return app;
          },
          async verifyInstalled() {},
        },
      });
    const a = make(),
      b = make();
    let pid, stalledPid;
    try {
      const [x, y] = await Promise.all([a.start(), b.start()]);
      pid = x.pid;
      assert.ok(pid > 1);
      assert.equal(y.pid, pid, "Concurrently started another native owner");
      assert.equal((await a.checkHealth()).pid, pid);
      await a.stop();
      await b.stop();
      assert.equal((await a.start()).pid, pid, "Closing a Host killed a shared Helper");
      await b.start();
      const next = await b.restart();
      assert.notEqual(next.pid, pid, "Reused Host could not restart the shared Helper");
      pid = next.pid;
      await a.start();
      const final = await a.restart();
      assert.notEqual(final.pid, pid, "Stale starter ownership prevented a later restart");
      pid = final.pid;
      const restart = b.restart(),
        stop = b.stop();
      const [restarted] = await Promise.all([restart, stop]);
      pid = restarted.pid;
      assert.equal(b.running, false, "A prior restart wrote running back after stop completed");
      stalledPid = pid;
      process.kill(stalledPid, "SIGSTOP");
      const recovered = await a.start();
      pid = recovered.pid;
      assert.notEqual(
        pid,
        stalledPid,
        "A verified stalled Helper prevented a new call from recovering",
      );
    } finally {
      await Promise.allSettled([a.stop(), b.stop()]);
      // 断言失败时也先按真实路径与出生身份收敛进程，保留文件直到确认退出。
      await cleanupHelper(app);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "captured product transport starts a source Helper lazily and reconnects after death",
  { skip: process.platform !== "darwin", timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kcua-runtime-live-"));
    const app = await developmentApp(dir);
    const env = {
      ...process.env,
      XDG_RUNTIME_DIR: dir,
      ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1",
      ZCODE_CUA_BUNDLED_HELPER_APP_PATH: app,
      ZCODE_CUA_HELPER_INSTALL_ROOT: resolve(app, ".."),
      ZCODE_CUA_PERMISSION_BROKER_SOCKET: undefined,
    };
    const socketPath = resolveBrokerSocketPath({ env });
    env.ZCODE_CUA_PERMISSION_BROKER_SOCKET = socketPath;
    const runtime = createComputerUseRuntime({ env, brokerSocketPath: socketPath });
    let pid;
    const brokerCall = async (method) => {
      const client = createBrokerClient({ socketPath });
      try {
        return await client.call(method);
      } finally {
        await client.close();
      }
    };
    const queryPid = async () => (await brokerCall("broker_info")).pid;
    const run = () =>
      runtime.execute({
        // 此用例验证传输入口，不验证 GUI。M2 锁屏时 list_apps 正确拒绝，不能误报为未启动。
        // 源码 request_access 只读取权限事实，不调用系统授权弹窗；真实 list/AX/截图另做验收。
        toolName: "request_access",
        arguments: {},
        context: { sessionId: "cold-runtime", workspaceKey: dir, runtimeScope: "main" },
      });
    try {
      const first = await run();
      assert.notEqual(first.isError, true, "Injected transport prevented lazy Helper startup");
      // 真实 Helper 的权限事实：SDK 读首个文本块里的 AccessStatus，桌面权限观察读 _meta。
      // 本机两项权限是否授予随环境变化，只断言取值范围与两处一致。
      const status = JSON.parse(first.content[0].text);
      for (const key of ["accessibility", "screenRecording"])
        assert.ok(["granted", "denied"].includes(status[key]), `${key} is not a known state`);
      assert.deepEqual(status, first.structuredContent);
      const facts = first._meta[CUA_REQUEST_ACCESS_STATUS_META_KEY];
      assert.equal(facts.grantOwner, "dev.zcode.cua-helper.kcode");
      assert.equal(facts.accessibility, status.accessibility);
      assert.equal(facts.screenRecording, status.screenRecording);
      assert.equal(cuaRequestAccessStatusSchema.safeParse(facts).success, true);
      pid = await queryPid();
      // 源码 request_access 只读取权限事实，不触发系统授权弹窗。
      assert.equal((await brokerCall("permission_status")).prompted, false);
      const previous = pid;
      process.kill(pid, "SIGKILL");
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        try {
          process.kill(previous, 0);
        } catch {
          break;
        }
        await pause(20);
      }
      assert.notEqual(
        (await run()).isError,
        true,
        "The next tool call could not reconnect after Helper death",
      );
      pid = await queryPid();
      assert.notEqual(pid, previous);
    } finally {
      await runtime.dispose().catch(() => {});
      await cleanupHelper(app);
      await rm(dir, { recursive: true, force: true });
    }
  },
);
