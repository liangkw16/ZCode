import { describe, expect, it, vi } from "vitest";

/**
 * CUA 的输出策略：参考按需取用，宿主不主动推。
 *
 * Bug（2026-09-11 真机）：首次 CUA 调用前 SDK 会把 docs/computer-use.md 自动写进输出，
 * 而模型刚通过 Skill 工具拿到大面积重合的 SKILL——同一份内容进上下文两遍（13.1KB +
 * 13.8KB，小节重合过半）。口径改成与 Browser Use 一致：文档由模型自己
 * `nodeRepl.write(await agent.documentation.get("computer-use"))` 取。
 *
 * 观察结果仍由 SDK 自动展示（`Target`）：v1 曾把它写成 SKILL 里的纪律，
 * 模型忘写就整段观察丢失，那次回退的结论保留在 computer-use-client.mjs 的注释里。
 */

const WRITTEN: string[] = [];

async function makeGlobals(bridgeOverrides: Record<string, unknown> = {}, platform = process.platform) {
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const clientUrl = fileURLToPath(new URL("../../zcode-cua-plugin/scripts/computer-use-client.mjs", import.meta.url));
  const documentationRoot = join(dirname(clientUrl), "..", "docs");
  const bridge = {
    call: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    assertAvailable: () => {},
    documentationRoot,
    ...bridgeOverrides,
  };
  const globals = {
    process: { platform },
    [Symbol.for("zcode.node-repl.computer-use-bridge")]: bridge,
    nodeRepl: { write: (text: string) => { WRITTEN.push(text); } },
  };
  const mod = await import(clientUrl);
  await mod.setupComputerUseRuntime({ globals });
  return { globals, bridge, mod };
}

const referenceOf = (writes: readonly string[]) =>
  writes.find((text) => text.startsWith("# Computer Use"));

describe("computer-use output policy", () => {
  it("never pushes the reference, on the first call or any later one", async () => {
    WRITTEN.length = 0;
    const { globals } = await makeGlobals();
    await globals.agent.computerUse.computer.list_apps({});
    expect(referenceOf(WRITTEN)).toBeUndefined();
    await globals.agent.computerUse.computer.list_apps({});
    expect(referenceOf(WRITTEN)).toBeUndefined();
  });

  it("serves the reference through agent.documentation for the model to write", async () => {
    const { globals } = await makeGlobals();
    const doc = await (
      globals.agent as { documentation: { get: (name: string) => Promise<string> } }
    ).documentation.get("computer-use");
    expect(doc).toMatch(/^# Computer Use/u);
    // 按需取用的那份仍是完整参考：模型需要参数形状时才付这份预算。
    expect(doc).toMatch(/## Tool arguments/u);
  });
});


// 2026-11-17 真机回归：中文输入法改写网址；macOS element_scroll 尚未实现。
async function makeTarget(platform: NodeJS.Platform) {
  const call = vi.fn(async () => ({
    content: [],
    structuredContent: {
      state_id: "browser-state",
      app: { pid: 123, bundle_id: "com.google.Chrome" },
      window: { window_id: 42 },
      elements: [{ index: 1 }],
      text: "1 browser content",
    },
  }));
  const { globals } = await makeGlobals({ call }, platform);
  const target = await globals.agent.computerUse.getApp({ bundle_id: "com.google.Chrome", window_id: 42 });
  call.mockClear();
  return { target, call };
}

describe("computer-use observation return values", () => {
  it("returns tree text directly and the combined tree in state", async () => {
    // 真机模型误读 .content 造成反复空匹配；锁定既有 SDK 返回契约，文档示例直接解析字符串。
    const { target } = await makeTarget("darwin");
    const tree = await target.getAXState({ emit: false, disableDiffing: true });
    expect(tree).toBe("1 browser content");
    const combined = await target.getAXStateAndScreenshot({ emit: false, disableDiffing: true });
    expect(combined.state).toBe(tree);
    expect(combined).not.toHaveProperty("content");
  });
});

describe("computer-use platform input dispatch", () => {
  it.each(["darwin", "win32", "linux"] as const)("preserves text and resolved identity on %s", async (platform) => {
    const { target, call } = await makeTarget(platform);
    const text = "http://127.0.0.1:53568/?验收=🌼&value=a/b";
    await target.typeText(text);
    expect(call).toHaveBeenCalledExactlyOnceWith(platform === "darwin" ? "paste" : "type", {
      text,
      app_ref: { pid: 123, bundle_id: "com.google.Chrome", window_id: 42 },
      ...(platform === "darwin" ? { format: "text" } : {}),
    });
  });

  it.each([
    ["darwin", undefined, "event"],
    ["darwin", "auto", "event"],
    ["darwin", "event", "event"],
    ["darwin", "a11y", "a11y"],
    ["win32", undefined, undefined],
    ["linux", "auto", "auto"],
  ] as const)("dispatches %s scroll strategy %s as %s", async (platform, requested, expected) => {
    const { target, call } = await makeTarget(platform);
    await target.scroll(1, "down", 2, requested ? { strategy: requested } : undefined);
    expect(call).toHaveBeenCalledExactlyOnceWith("scroll", {
      target: { type: "element", index: 1 },
      app_ref: { pid: 123, bundle_id: "com.google.Chrome", window_id: 42 },
      scroll_direction: "down",
      scroll_amount: 2,
      ...(expected ? { strategy: expected } : {}),
    });
  });

  it("does not replay a failed paste that may already have been sent", async () => {
    const { target, call } = await makeTarget("darwin");
    call.mockRejectedValueOnce(new Error("possibly_sent"));
    await expect(target.typeText("single insertion")).rejects.toThrow("possibly_sent");
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("computer-use producer action receipts", () => {
  it("rejects possibly_sent from the real action_receipt envelope without replay", async () => {
    const { target, call } = await makeTarget("darwin");
    call.mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            action_receipt: {
              schema_version: "zcode-cua-action-receipt-v1",
              action_sent: true,
              dispatch_status: "possibly_sent",
              retry_action: false,
            },
          }),
        },
      ],
      isError: false,
    });
    await expect(target.scroll(1, "down", 1)).rejects.toMatchObject({
      name: "ComputerUseError",
      code: "TIMEOUT",
      actionSent: true,
      dispatchStatus: "possibly_sent",
      retry: "reobserve",
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each([
    [false, true, "accepted"],
    [true, false, "not_sent"],
  ] as const)(
    "preserves isError=%s action_sent=%s dispatch=%s",
    async (isError, actionSent, dispatch) => {
      const { target, call } = await makeTarget("darwin");
      call.mockResolvedValueOnce({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              action_receipt: {
                action_sent: actionSent,
                dispatch_status: dispatch,
              },
            }),
          },
        ],
        structuredContent: { code: "permission_denied" },
        isError,
      });
      const action = target.scroll(1, "down", 1);
      if (isError)
        await expect(action).rejects.toMatchObject({
          code: "PERMISSION_DENIED",
          actionSent: false,
          dispatchStatus: "not_sent",
          retry: "never",
        });
      else await expect(action).resolves.toBeUndefined();
      expect(call).toHaveBeenCalledTimes(1);
    },
  );
});
