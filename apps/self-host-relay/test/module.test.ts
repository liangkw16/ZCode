import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { loadSelfHostRelayConfig, startSelfHostRelay } from "../src/module.js";

const SECRET = "secret-module";
const dirs: string[] = [];
const runtimes: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadSelfHostRelayConfig", () => {
  it("默认值与必填 secret", () => {
    expect(loadSelfHostRelayConfig({ SELF_HOST_RELAY_SECRET: SECRET })).toEqual({
      host: "0.0.0.0",
      port: 8787,
      secret: SECRET,
      devicesFile: undefined,
      staticRoot: undefined,
    });
    expect(loadSelfHostRelayConfig({ SELF_HOST_RELAY_SECRET: "x", SELF_HOST_RELAY_PORT: "9000" }).port).toBe(9000);
    expect(() => loadSelfHostRelayConfig({})).toThrow(/SELF_HOST_RELAY_SECRET/);
  });
});

describe("startSelfHostRelay", () => {
  it("装配后注册→token→auth_init 全链路，设备表防抖落盘并可恢复", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-module-"));
    dirs.push(dir);
    const devicesFile = join(dir, "devices.json");
    writeFileSync(
      devicesFile,
      JSON.stringify({ version: 1, devices: [{ deviceSid: "d_old", deviceMid: "mid-old", createdAt: 1 }] }),
    );
    const runtime = await startSelfHostRelay({
      host: "127.0.0.1",
      port: 0,
      secret: SECRET,
      devicesFile,
    });
    runtimes.push(runtime);
    const base = `http://127.0.0.1:${runtime.port}`;

    const list = await fetch(`${base}/api/v1/remote/device`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    }).then((r) => r.json() as Promise<{ data: { device_sid: string }[] }>);
    expect(list.data.some((d) => d.device_sid === "d_old")).toBe(true);

    const register = await fetch(`${base}/api/v1/remote/device`, {
      method: "POST",
      headers: { Authorization: "Bearer any", "Content-Type": "application/json" },
      body: JSON.stringify({ device_mid: "mid-new" }),
    }).then((r) => r.json() as Promise<{ data: { device_sid: string } }>);
    const sid = register.data.device_sid;

    const token = await fetch(`${base}/api/v1/remote/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "device" }),
    }).then((r) => r.json() as Promise<{ data: { token: string } }>);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${runtime.port}/api/v1/remote/ws2?token=${token.data.token}`);
      socket.on("open", () => {
        socket.send(JSON.stringify({ type: "auth_init", device_sid: sid, meta: { name: "n" } }));
      });
      socket.on("message", (data) => {
        if (JSON.parse(data.toString()).type === "auth_ack") {
          socket.close();
          resolve();
        }
      });
      socket.on("error", reject);
    });

    await new Promise((resolve) => setTimeout(resolve, 1_600)); // 防抖落盘窗口
    expect(existsSync(devicesFile)).toBe(true);
    const persisted = JSON.parse(readFileSync(devicesFile, "utf-8")) as {
      devices: { deviceSid: string }[];
    };
    expect(persisted.devices.some((d) => d.deviceSid === sid)).toBe(true);
    expect(persisted.devices.some((d) => d.deviceSid === "d_old")).toBe(true);

    // 重启恢复：新进程读取同一 devices.json，旧 SID 仍可认证。
    await runtime.close();
    const reboot = await startSelfHostRelay({ host: "127.0.0.1", port: 0, secret: SECRET, devicesFile });
    runtimes.push(reboot);
    const list2 = await fetch(`http://127.0.0.1:${reboot.port}/api/v1/remote/device`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    }).then((r) => r.json() as Promise<{ data: { device_sid: string; online: boolean }[] }>);
    expect(list2.data.find((d) => d.device_sid === sid)!.online).toBe(false);

    // 有在线 WS 连接时 close() 也必须在限时内完成（网关终止 + server.close 不挂起）。
    const token3 = await fetch(`http://127.0.0.1:${reboot.port}/api/v1/remote/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ role: "device" }),
    }).then((r) => r.json() as Promise<{ data: { token: string } }>);
    const liveSocket = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${reboot.port}/api/v1/remote/ws2?token=${token3.data.token}`);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
    });
    await expect(
      Promise.race([
        reboot.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout")), 5_000)),
      ]),
    ).resolves.toBeUndefined();
    liveSocket.close();
  }, 20_000);

  it("持久化写失败（devicesFile 不可写路径）不崩进程、不阻断后续请求", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-module-eisdir-"));
    dirs.push(dir);
    // 用目录占位目标路径：writeFile 报 EISDIR/ENOENT，验证失败只记日志不抛出。
    const blockedFile = join(dir, "as-dir");
    mkdirSync(blockedFile);
    const devicesFile = join(blockedFile, "devices.json");
    const runtime = await startSelfHostRelay({ host: "127.0.0.1", port: 0, secret: SECRET, devicesFile });
    runtimes.push(runtime);
    const registered = await fetch(`http://127.0.0.1:${runtime.port}/api/v1/remote/device`, {
      method: "POST",
      headers: { Authorization: "Bearer any", "Content-Type": "application/json" },
      body: JSON.stringify({ device_mid: "mid-persist-fail" }),
    });
    expect(registered.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_600)); // 越过防抖窗口，触发失败写盘
    const after = await fetch(`http://127.0.0.1:${runtime.port}/api/v1/remote/device`, {
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(after.status).toBe(200); // 进程仍存活且可服务
  }, 20_000);
});
