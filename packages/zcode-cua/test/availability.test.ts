import { describe, expect, it } from "vitest";
import { createComputerUseRuntime } from "../index.js";
import { callBrokerMethod } from "../broker.js";
import { isCuaPermissionStatusAvailable } from "../broker-ports.js";
import { startInProcessComputerUseBroker } from "../broker-in-process.js";
import { BROKER_SOCKET_ENV, IN_PROCESS_BROKER_SOCKET, mintBrokerSocketPath } from "../broker-socket-path.js";

describe("Computer Use public admission", () => {
  it("正常权限结果不要求 available 标记，不可用和无效结果不能冒充权限真值", () => {
    expect(
      isCuaPermissionStatusAvailable({
        grantOwner: null,
        accessibility: "granted",
        screenRecording: "denied",
      }),
    ).toBe(true);
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

  it("未知 broker 方法在连接前拒绝", async () => {
    await expect(
      callBrokerMethod({ method: "example", socketPath: "unused" }),
    ).rejects.toMatchObject({ code: "method_not_found" });
  });

  it("进程内 broker 入口明确报告不可用，socketPath 入口保留独立 CLI 需要的常量", async () => {
    await expect(startInProcessComputerUseBroker()).rejects.toMatchObject({
      code: "helper_unavailable",
    });
    expect(BROKER_SOCKET_ENV).toBe("ZCODE_CUA_PERMISSION_BROKER_SOCKET");
    expect(IN_PROCESS_BROKER_SOCKET).toBe("in-process");
    expect(mintBrokerSocketPath()).toMatch(/\.sock$/u);
  });
});
