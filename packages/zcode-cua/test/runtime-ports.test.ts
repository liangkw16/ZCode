import { afterEach, describe, expect, it } from "vitest";

// 与 runtime.test.ts 分文件的理由：那边走真实装配的 socket 夹具，覆盖请求契约；
// 这里直接注入 RuntimePorts，验证端口缺失或失败时运行时的降级语义。
const context = {
  sessionId: "s1",
  runtimeScope: "main" as const,
  workspaceKey: "/work",
  workspacePath: "/work",
  workspaceIdentity: "one",
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

// 不经过产品装配、直接注入端口的运行时用例：停止标记与权限事实采样的接线。
describe("runtime with injected ports", () => {
  async function runtimeFixture(
    options: { freshPermissions?: () => Promise<unknown> } = {},
  ) {
    const { createRuntime } = await import("../src/app/runtime.js");
    const dispatched: string[] = [];
    let failPrepare = true;
    let pending: Promise<void> | undefined;
    const runtime = createRuntime({
      id: () => "fixture",
      prepare: async () => {
        if (pending) await pending;
        if (failPrepare) throw new Error("helper unavailable");
      },
      broker: {
        generation: "g1",
        epoch: () => 0,
        call: async (method: string) => {
          dispatched.push(method);
          if (method === "request_access")
            return {
              grant_owner: "dev.zcode.cua-helper.kcode",
              accessibility: "granted",
              screen_recording: "granted",
              desktop_availability: "unlocked",
            };
          return { action_sent: true, dispatch_status: "accepted" };
        },
        close: async () => {},
      },
      ...(options.freshPermissions ? { freshPermissions: options.freshPermissions } : {}),
    } as any);
    cleanups.push(() => runtime.dispose());
    const run = (toolName: string, args: unknown = {}) =>
      runtime.execute({ toolName, arguments: args, context });
    return {
      run,
      dispatched,
      recoverPrepare: () => (failPrepare = false),
      // 让之后的 prepare() 都停在栅栏上，直到返回的函数被调用。
      blockPrepare: () => {
        let release!: () => void;
        pending = new Promise<void>((resolve) => (release = resolve));
        return release;
      },
    };
  }
  it("keeps the session stopped when Helper preparation fails during stop", async () => {
    const f = await runtimeFixture();
    // stop 请求本身因准备失败而报错，但停止标记已经落下。
    expect((await f.run("stop_computer_control", { reason: "user" })).isError).toBe(true);
    f.recoverPrepare();
    const key = await f.run("key", { app_ref: { pid: 700 }, text: "ENTER" });
    expect(key.structuredContent).toMatchObject({
      error: { code: "stopped" },
      action_receipt: { dispatch_status: "not_sent" },
    });
    expect(f.dispatched).not.toContain("press_key_to_app");
    expect((await f.run("stop_computer_control", { reason: "user" })).isError).not.toBe(true);
  });
  it("re-checks the stop latch after a request has finished waiting for preparation", async () => {
    const f = await runtimeFixture();
    f.recoverPrepare();
    const release = f.blockPrepare();
    const blocked = f.run("key", { app_ref: { pid: 700 }, text: "ENTER" });
    // 等待 prepare() 期间到达的 stop 同样生效。
    const stopped = f.run("stop_computer_control", { reason: "user" });
    release();
    expect((await stopped).isError).not.toBe(true);
    const key = await blocked;
    expect(key.structuredContent).toMatchObject({ error: { code: "stopped" } });
    expect(f.dispatched).not.toContain("press_key_to_app");
  });
  it("reports freshly sampled permissions instead of the resident Helper snapshot", async () => {
    // 常驻进程的录屏 preflight 在系统撤销授权后仍可能是旧的 granted（规范 §8.3）。
    const f = await runtimeFixture({
      freshPermissions: async () => ({ accessibility: "granted", screen_recording: "denied" }),
    });
    f.recoverPrepare();
    const access = await f.run("request_access", {});
    expect(access.structuredContent).toMatchObject({
      ready: false,
      accessibility: "granted",
      screenRecording: "denied",
    });
  });
  it("reports unknown permissions when the fresh sample fails", async () => {
    const f = await runtimeFixture({
      freshPermissions: async () => {
        throw new Error("fresh preflight did not reply");
      },
    });
    f.recoverPrepare();
    const access = await f.run("request_access", {});
    expect(access.structuredContent).toMatchObject({
      ready: false,
      accessibility: "unknown",
      screenRecording: "unknown",
    });
  });
  it("keeps the resident snapshot when no fresh sampler is wired", async () => {
    const f = await runtimeFixture();
    f.recoverPrepare();
    const access = await f.run("request_access", {});
    expect(access.structuredContent).toMatchObject({
      ready: true,
      accessibility: "granted",
      screenRecording: "granted",
    });
  });
});
