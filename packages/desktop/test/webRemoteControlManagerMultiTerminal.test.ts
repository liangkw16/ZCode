import { describe, expect, it, vi } from "vitest";
import { createManagerHarness } from "./webRemoteControlManagerExternalRelay.test.js";
import type { WebRemoteControlAppPayload } from "@zcode/shared";

const workspacePath = "/workspace/demo";

async function bridgeOpenPayload(id: string): Promise<WebRemoteControlAppPayload> {
  return {
    zcode_type: "workspace-bridge-open",
    requestId: `bridge-${id}`,
    bridgeSessionId: `bridge-${id}`,
    workspaceKey: workspacePath,
  } as WebRemoteControlAppPayload;
}

describe("web remote control multi-terminal sessions", () => {
  it("terminal 从集合消失后 30s 才释放，宽限内重连保留 bridge", async () => {
    const h = createManagerHarness();
    await h.manager.start(1, { workspacePath });
    h.emitTransportState("paired");
    h.deliverPayload(await bridgeOpenPayload("a"), "tA");
    await vi.waitFor(() =>
      expect(h.sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-bridge-ready",
          bridgeSessionId: "bridge-a",
        }),
      ),
    );
    const attachmentA = (
      await h.defaultAttachWorkspaceHost.mock.results[0]!.value
    ).attachmentId;

    vi.useFakeTimers();
    h.emitTerminalIds([]);
    await vi.advanceTimersByTimeAsync(10_000);
    h.deliverPayload({ zcode_type: "bootstrap-request", requestId: "back" }, "tA");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.releaseWorkspaceHostAttachment).not.toHaveBeenCalledWith(attachmentA);

    h.emitTerminalIds([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.releaseWorkspaceHostAttachment).toHaveBeenCalledWith(attachmentA);
    await h.manager.stop(1);
    vi.useRealTimers();
  });

  it("关闭一个 terminal 不影响另一个的 bridge", async () => {
    const h = createManagerHarness();
    await h.manager.start(1, { workspacePath });
    h.emitTransportState("paired");
    h.deliverPayload(await bridgeOpenPayload("tA"), "tA");
    h.deliverPayload(await bridgeOpenPayload("tB"), "tB");
    await vi.waitFor(() =>
      expect(
        h.sentPayloads.filter((p) => p.zcode_type === "workspace-bridge-ready"),
      ).toHaveLength(2),
    );
    const [a, b] = (
      await Promise.all(
        h.defaultAttachWorkspaceHost.mock.results.map((result) => result.value),
      )
    ).map((result) => result.attachmentId);

    vi.useFakeTimers();
    h.emitTerminalIds(["tB"]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.releaseWorkspaceHostAttachment).toHaveBeenCalledWith(a);
    expect(h.releaseWorkspaceHostAttachment).not.toHaveBeenCalledWith(b);
    await h.manager.stop(1);
    vi.useRealTimers();
  });

  it("停止窗口立即释放全部 session", async () => {
    const h = createManagerHarness();
    await h.manager.start(1, { workspacePath });
    h.emitTransportState("paired");
    h.deliverPayload(await bridgeOpenPayload("tA"), "tA");
    h.deliverPayload(await bridgeOpenPayload("tB"), "tB");
    await vi.waitFor(() =>
      expect(h.defaultAttachWorkspaceHost).toHaveBeenCalledTimes(2),
    );
    const [a, b] = (
      await Promise.all(
        h.defaultAttachWorkspaceHost.mock.results.map((result) => result.value),
      )
    ).map((result) => result.attachmentId);
    await h.manager.stop(1);
    expect(h.releaseWorkspaceHostAttachment).toHaveBeenCalledWith(a);
    expect(h.releaseWorkspaceHostAttachment).toHaveBeenCalledWith(b);
  });
});
