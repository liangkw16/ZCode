import { describe, expect, it } from "vitest";
import { createComputerUseRuntime } from "../index.js";
import { callBrokerMethod } from "../broker.js";
import { isCuaPermissionStatusAvailable } from "../broker-ports.js";

describe("Computer Use placeholder", () => {
  it("正常权限结果不要求 available 标记，不可用和无效结果不能冒充权限真值", () => {
    expect(isCuaPermissionStatusAvailable({ grantOwner: null, accessibility: "granted", screenRecording: "denied" })).toBe(true);
    expect(isCuaPermissionStatusAvailable({ available: false, reason: "unavailable" })).toBe(false);
    expect(isCuaPermissionStatusAvailable({} as never)).toBe(false);
  });
  it("执行入口明确报告不可用，且不触发真实 broker 准备", async () => {
    let prepared = false;
    const runtime = createComputerUseRuntime({
      ensureBrokerAvailable: async () => {
        prepared = true;
      },
    });
    await expect(
      runtime.execute({
        toolName: "computer_use",
        arguments: {},
        context: { sessionId: "example", runtimeScope: "main", workspaceKey: "example" },
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(prepared).toBe(false);
    await runtime.dispose();
  });

  it("broker 方法拒绝执行真实系统能力", async () => {
    await expect(
      callBrokerMethod({ method: "example", socketPath: "unused" }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
});
