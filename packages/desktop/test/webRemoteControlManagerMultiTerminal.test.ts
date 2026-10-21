import { describe, expect, it, vi } from "vitest";
import { createManagerHarness } from "./webRemoteControlManagerExternalRelay.test.js";
import { encodeWebRemoteControlRpcTransportMessage } from "@zcode/shared";
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

  it("两个 session 的 bootstrap 和 workspace-list 推送互不串台", async () => {
    const h = createManagerHarness();
    await h.manager.start(1, { workspacePath });
    h.emitTransportState("paired");
    h.sentPayloads.length = 0;
    h.sentTargets.length = 0;

    h.deliverPayload({ zcode_type: "bootstrap-request", requestId: "a" }, "tA");
    h.deliverPayload({ zcode_type: "bootstrap-request", requestId: "b" }, "tB");
    await vi.waitFor(() =>
      expect(
        h.sentPayloads.filter((p) => p.zcode_type === "bootstrap-response"),
      ).toHaveLength(2),
    );
    const bootstrapTargets = h.sentPayloads
      .map((payload, index) => ({ payload, target: h.sentTargets[index] }))
      .filter((entry) => entry.payload.zcode_type === "bootstrap-response")
      .map((entry) => entry.target);
    expect(bootstrapTargets).toEqual(["tA", "tB"]);

    h.sentPayloads.length = 0;
    h.sentTargets.length = 0;
    h.manager.syncAvailableWorkspaces(1, [
      { workspacePath, label: "demo", kind: "local" },
    ]);
    await vi.waitFor(() =>
      expect(
        h.sentPayloads.filter((p) => p.zcode_type === "workspace-list-updated"),
      ).toHaveLength(2),
    );
    const pushTargets = h.sentPayloads
      .map((payload, index) => ({ payload, target: h.sentTargets[index] }))
      .filter((entry) => entry.payload.zcode_type === "workspace-list-updated")
      .map((entry) => entry.target);
    expect(pushTargets).toEqual(["tA", "tB"]);
    await h.manager.stop(1);
  });

  it("session 丢失 bridge 后收到旧 rpc-frame 会定向回 bridge-degraded", async () => {
    const h = createManagerHarness();
    await h.manager.start(1, { workspacePath });
    h.emitTransportState("paired");
    h.sentPayloads.length = 0;

    const [frame] = encodeWebRemoteControlRpcTransportMessage(
      new Uint8Array([1, 2, 3]),
      {
        bridgeSessionId: "bridge-lost",
        firstPhysicalSeq: 1,
        messageSeq: 1,
      },
    );
    h.deliverPayload(frame, "tA");

    await vi.waitFor(() =>
      expect(h.sentPayloads).toContainEqual(
        expect.objectContaining({
          zcode_type: "bridge-degraded",
          bridgeSessionId: "bridge-lost",
        }),
      ),
    );
    expect(h.sentTargets.at(-1)).toBe("tA");
    await h.manager.stop(1);
  });

  it("活跃页面断开后状态事件切到剩余页面，订阅者不保留旧查看", async () => {
    const events: { mobileTaskView?: { taskId?: string } | null }[] = [];
    const h = createManagerHarness({
      onStatusChanged: (_windowId, status) => {
        events.push({ mobileTaskView: status.mobileTaskView });
      },
    });
    await h.manager.start(1, { workspacePath });
    h.emitTransportState("paired");
    for (const id of ["tA", "tB"]) {
      h.deliverPayload(await bridgeOpenPayload(id), id);
    }
    await vi.waitFor(() =>
      expect(
        h.sentPayloads.filter((p) => p.zcode_type === "workspace-bridge-ready"),
      ).toHaveLength(2),
    );
    const epochs = new Map<string, string>();
    for (const id of ["tA", "tB"]) {
      h.sentPayloads.length = 0;
      h.sentTargets.length = 0;
      h.deliverPayload({ zcode_type: "bootstrap-request", requestId: `boot-${id}` }, id);
      const response = h.sentPayloads.find(
        (payload) =>
          payload.zcode_type === "bootstrap-response" && payload.requestId === `boot-${id}`,
      ) as unknown as { result: { mobileTaskViewEpoch?: string } };
      epochs.set(id, response.result.mobileTaskViewEpoch!);
    }

    for (const id of ["tA", "tB"]) {
      h.deliverPayload(
        {
          zcode_type: "mobile-task-view-update",
          bridgeSessionId: `bridge-${id}`,
          epoch: epochs.get(id),
          seq: 1,
          view: { workspacePath, taskId: `task-${id}` },
        },
        id,
      );
    }
    expect(h.manager.getStatus(1).mobileTaskView).toMatchObject({ taskId: "task-tB" });

    h.emitTerminalIds(["tA"]);
    await vi.waitFor(() =>
      expect(h.manager.getStatus(1).mobileTaskView).toMatchObject({ taskId: "task-tA" }),
    );
    const lastEvent = events.at(-1);
    expect(lastEvent?.mobileTaskView).toMatchObject({ taskId: "task-tA" });
    await h.manager.stop(1);
  });

  it("未选任务的页面不被共享偏好串入其它页面的 taskId", async () => {
    const h = createManagerHarness();
    await h.manager.start(1, { workspacePath });
    h.emitTransportState("paired");
    h.manager.syncAvailableWorkspaces(1, [
      { workspacePath: "/workspace/A", label: "A", kind: "local" },
      { workspacePath: "/workspace/B", label: "B", kind: "local" },
    ]);
    // B 停留在 B 首页（无 activeTaskId）；A 随后在 A 打开 taskA 并写入共享偏好。
    h.deliverPayload(
      {
        zcode_type: "mobile-view-state-update",
        viewState: { activeWorkspaceKey: "/workspace/B", updatedAt: 1 },
      },
      "tB",
    );
    h.deliverPayload(
      {
        zcode_type: "mobile-view-state-update",
        viewState: { activeWorkspaceKey: "/workspace/A", activeTaskId: "taskA", updatedAt: 2 },
      },
      "tA",
    );
    h.sentPayloads.length = 0;
    h.sentTargets.length = 0;
    h.deliverPayload({ zcode_type: "workspace-list-request", requestId: "b-list" }, "tB");
    const response = await vi.waitFor(() => {
      const found = h.sentPayloads.find(
        (payload) =>
          payload.zcode_type === "workspace-list-response" && payload.requestId === "b-list",
      );
      expect(found).toBeDefined();
      return found as unknown as {
        result: { activeWorkspaceKey?: string; activeTaskId?: string };
      };
    });
    expect(response.result.activeWorkspaceKey).toBe("/workspace/B");
    expect(response.result.activeTaskId).toBeUndefined();
    await h.manager.stop(1);
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
