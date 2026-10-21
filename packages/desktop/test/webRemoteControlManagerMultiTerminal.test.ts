import { describe, expect, it, vi } from "vitest";
import { createManagerHarness } from "./webRemoteControlManagerExternalRelay.test.js";
import { encodeWebRemoteControlRpcTransportMessage } from "@zcode/shared";
import type { WebRemoteControlAppPayload } from "@zcode/shared";

const workspacePath = "/workspace/demo";

async function bridgeOpenPayload(
  id: string,
): Promise<WebRemoteControlAppPayload> {
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
    h.deliverPayload(
      { zcode_type: "bootstrap-request", requestId: "back" },
      "tA",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.releaseWorkspaceHostAttachment).not.toHaveBeenCalledWith(
      attachmentA,
    );

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
      h.deliverPayload(
        { zcode_type: "bootstrap-request", requestId: `boot-${id}` },
        id,
      );
      const response = h.sentPayloads.find(
        (payload) =>
          payload.zcode_type === "bootstrap-response" &&
          payload.requestId === `boot-${id}`,
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
    expect(h.manager.getStatus(1).mobileTaskView).toMatchObject({
      taskId: "task-tB",
    });

    h.emitTerminalIds(["tA"]);
    await vi.waitFor(() =>
      expect(h.manager.getStatus(1).mobileTaskView).toMatchObject({
        taskId: "task-tA",
      }),
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
        viewState: {
          activeWorkspaceKey: "/workspace/A",
          activeTaskId: "taskA",
          updatedAt: 2,
        },
      },
      "tA",
    );
    h.sentPayloads.length = 0;
    h.sentTargets.length = 0;
    h.deliverPayload(
      { zcode_type: "workspace-list-request", requestId: "b-list" },
      "tB",
    );
    const response = await vi.waitFor(() => {
      const found = h.sentPayloads.find(
        (payload) =>
          payload.zcode_type === "workspace-list-response" &&
          payload.requestId === "b-list",
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

  describe("task view exclusivity", () => {
    async function openBridgedSessionsWithEpochs(
      h: ReturnType<typeof createManagerHarness>,
      ids: string[],
    ): Promise<Map<string, string>> {
      for (const id of ids) {
        h.deliverPayload(await bridgeOpenPayload(id), id);
      }
      await vi.waitFor(() =>
        expect(
          h.sentPayloads.filter(
            (p) => p.zcode_type === "workspace-bridge-ready",
          ),
        ).toHaveLength(ids.length),
      );
      const epochs = new Map<string, string>();
      for (const id of ids) {
        h.sentPayloads.length = 0;
        h.deliverPayload(
          { zcode_type: "bootstrap-request", requestId: `boot-${id}` },
          id,
        );
        const response = await vi.waitFor(() => {
          const found = h.sentPayloads.find(
            (payload) =>
              payload.zcode_type === "bootstrap-response" &&
              payload.requestId === `boot-${id}`,
          );
          expect(found).toBeDefined();
          return found as unknown as {
            result: { mobileTaskViewEpoch?: string };
          };
        });
        epochs.set(id, response.result.mobileTaskViewEpoch!);
      }
      return epochs;
    }

    function reportTaskView(
      h: ReturnType<typeof createManagerHarness>,
      id: string,
      epoch: string | undefined,
      seq: number,
      view: { workspacePath: string; taskId: string } | null,
      bridgeId = id,
    ): void {
      h.deliverPayload(
        {
          zcode_type: "mobile-task-view-update",
          bridgeSessionId: `bridge-${bridgeId}`,
          epoch,
          seq,
          view,
        },
        id,
      );
    }

    it("后开者接管同任务视图：旧持有者被定向通知并断桥（输入禁入），Host 资源与 B 不受影响", async () => {
      const h = createManagerHarness();
      await h.manager.start(1, { workspacePath });
      h.emitTransportState("paired");
      const epochs = await openBridgedSessionsWithEpochs(h, ["tA", "tB"]);
      const attachments = (
        await Promise.all(
          h.defaultAttachWorkspaceHost.mock.results.map(
            (result) => result.value,
          ),
        )
      ).map((result) => result.attachmentId);

      h.sentPayloads.length = 0;
      h.sentTargets.length = 0;
      reportTaskView(h, "tA", epochs.get("tA"), 1, {
        workspacePath,
        taskId: "task-X",
      });
      reportTaskView(h, "tB", epochs.get("tB"), 1, {
        workspacePath,
        taskId: "task-X",
      });

      const preemptIndex = await vi.waitFor(() => {
        const index = h.sentPayloads.findIndex(
          (payload) => payload.zcode_type === "mobile-task-view-preempted",
        );
        expect(index).toBeGreaterThanOrEqual(0);
        return index;
      });
      expect(h.sentPayloads[preemptIndex]).toMatchObject({
        zcode_type: "mobile-task-view-preempted",
        bridgeSessionId: "bridge-tA",
        workspaceKey: workspacePath,
        taskId: "task-X",
        reason: "opened-by-other-terminal",
      });
      expect(h.sentTargets[preemptIndex]).toBe("tA");
      // 输入禁入：A 的页面侧 attachment 立即释放；B 的保留（Host/agent 执行不受影响）。
      expect(h.releaseWorkspaceHostAttachment).toHaveBeenCalledWith(
        attachments[0],
      );
      expect(h.releaseWorkspaceHostAttachment).not.toHaveBeenCalledWith(
        attachments[1],
      );
      // app 层请求不依赖 bridge：A 仍可 bootstrap。
      h.sentPayloads.length = 0;
      h.sentTargets.length = 0;
      h.deliverPayload(
        { zcode_type: "bootstrap-request", requestId: "a-after" },
        "tA",
      );
      await vi.waitFor(() =>
        expect(h.sentPayloads).toContainEqual(
          expect.objectContaining({
            zcode_type: "bootstrap-response",
            requestId: "a-after",
          }),
        ),
      );
      await h.manager.stop(1);
    });

    it("禁入期 bridge-open 被拒（workspace-closed），view=null 解禁后可重建并接管", async () => {
      const h = createManagerHarness();
      await h.manager.start(1, { workspacePath });
      h.emitTransportState("paired");
      const epochs = await openBridgedSessionsWithEpochs(h, ["tA", "tB"]);

      reportTaskView(h, "tA", epochs.get("tA"), 1, {
        workspacePath,
        taskId: "task-X",
      });
      reportTaskView(h, "tB", epochs.get("tB"), 1, {
        workspacePath,
        taskId: "task-X",
      });
      await vi.waitFor(() =>
        expect(h.sentPayloads).toContainEqual(
          expect.objectContaining({ zcode_type: "mobile-task-view-preempted" }),
        ),
      );

      // 旧 web 的恢复链路：断桥后重建 bridge → 被禁入拒绝，提示已在他页打开。
      h.sentPayloads.length = 0;
      h.sentTargets.length = 0;
      h.deliverPayload(await bridgeOpenPayload("tA"), "tA");
      const rejected = await vi.waitFor(() => {
        const found = h.sentPayloads.find(
          (payload) => payload.zcode_type === "workspace-bridge-error",
        );
        expect(found).toBeDefined();
        return found as { reason: string; error: string };
      });
      expect(rejected.reason).toBe("workspace-closed");
      expect(rejected.error).toContain("其他页面");
      expect(h.sentTargets.at(-1)).toBe("tA");

      // 旧 web 式重报（pageshow）不得反踢持有者；B 重报同任务无新通知。
      h.sentPayloads.length = 0;
      reportTaskView(h, "tA", epochs.get("tA"), 2, {
        workspacePath,
        taskId: "task-X",
      });
      reportTaskView(h, "tB", epochs.get("tB"), 2, {
        workspacePath,
        taskId: "task-X",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        h.sentPayloads.filter(
          (p) => p.zcode_type === "mobile-task-view-preempted",
        ),
      ).toHaveLength(0);

      // view=null（退出聊天页）是唯一解禁途径：无 bridge 也必须接受。
      reportTaskView(h, "tA", epochs.get("tA"), 3, null);
      h.sentPayloads.length = 0;
      // 解禁后重建 bridge 成功（真实恢复会换 bridge 标识），再次声明同任务 = 对称接管。
      h.deliverPayload(await bridgeOpenPayload("tA-r2"), "tA");
      await vi.waitFor(() =>
        expect(h.sentPayloads).toContainEqual(
          expect.objectContaining({
            zcode_type: "workspace-bridge-ready",
            bridgeSessionId: "bridge-tA-r2",
          }),
        ),
      );
      reportTaskView(
        h,
        "tA",
        epochs.get("tA"),
        4,
        { workspacePath, taskId: "task-X" },
        "tA-r2",
      );
      await vi.waitFor(() =>
        expect(h.sentPayloads).toContainEqual(
          expect.objectContaining({
            zcode_type: "mobile-task-view-preempted",
            bridgeSessionId: "bridge-tB",
          }),
        ),
      );
      expect(h.manager.getStatus(1).mobileTaskView).toMatchObject({
        taskId: "task-X",
      });
      await h.manager.stop(1);
    });

    it("同 session 重复上报自己的任务不触发抢占；不同任务互不干扰", async () => {
      const h = createManagerHarness();
      await h.manager.start(1, { workspacePath });
      h.emitTransportState("paired");
      const epochs = await openBridgedSessionsWithEpochs(h, ["tA", "tB"]);

      reportTaskView(h, "tA", epochs.get("tA"), 1, {
        workspacePath,
        taskId: "task-X",
      });
      reportTaskView(h, "tA", epochs.get("tA"), 2, {
        workspacePath,
        taskId: "task-X",
      });
      reportTaskView(h, "tB", epochs.get("tB"), 1, {
        workspacePath,
        taskId: "task-Y",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        h.sentPayloads.filter(
          (p) => p.zcode_type === "mobile-task-view-preempted",
        ),
      ).toHaveLength(0);
      expect(h.releaseWorkspaceHostAttachment).not.toHaveBeenCalled();
      await h.manager.stop(1);
    });

    it("transport 离开 paired 清除禁入：恢复后重建 bridge 即可持有", async () => {
      const h = createManagerHarness();
      await h.manager.start(1, { workspacePath });
      h.emitTransportState("paired");
      const epochs = await openBridgedSessionsWithEpochs(h, ["tA", "tB"]);

      reportTaskView(h, "tA", epochs.get("tA"), 1, {
        workspacePath,
        taskId: "task-X",
      });
      reportTaskView(h, "tB", epochs.get("tB"), 1, {
        workspacePath,
        taskId: "task-X",
      });
      await vi.waitFor(() =>
        expect(h.sentPayloads).toContainEqual(
          expect.objectContaining({ zcode_type: "mobile-task-view-preempted" }),
        ),
      );

      // 断线（视图与禁入整体重置）→ 恢复 → A 重建 bridge 后声明同任务应成功。
      h.emitTransportState("connecting");
      h.emitTransportState("paired");
      h.sentPayloads.length = 0;
      h.deliverPayload(await bridgeOpenPayload("tA-r2"), "tA");
      await vi.waitFor(() =>
        expect(h.sentPayloads).toContainEqual(
          expect.objectContaining({
            zcode_type: "workspace-bridge-ready",
            bridgeSessionId: "bridge-tA-r2",
          }),
        ),
      );
      h.sentPayloads.length = 0;
      h.deliverPayload(
        { zcode_type: "bootstrap-request", requestId: "boot-tA-again" },
        "tA",
      );
      const response = await vi.waitFor(() => {
        const found = h.sentPayloads.find(
          (payload) =>
            payload.zcode_type === "bootstrap-response" &&
            payload.requestId === "boot-tA-again",
        );
        expect(found).toBeDefined();
        return found as unknown as { result: { mobileTaskViewEpoch?: string } };
      });
      expect(response.result.mobileTaskViewEpoch).toBeTruthy();
      h.sentPayloads.length = 0;
      reportTaskView(
        h,
        "tA",
        response.result.mobileTaskViewEpoch,
        1,
        { workspacePath, taskId: "task-X" },
        "tA-r2",
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(
        h.sentPayloads.filter(
          (p) => p.zcode_type === "mobile-task-view-preempted",
        ),
      ).toHaveLength(0);
      expect(h.manager.getStatus(1).mobileTaskView).toMatchObject({
        taskId: "task-X",
      });
      await h.manager.stop(1);
    });
  });
});
