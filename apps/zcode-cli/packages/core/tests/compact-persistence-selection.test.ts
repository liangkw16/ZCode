import { describe, expect, it, vi } from "vitest";
import type { MessageInfo } from "@zcode/contracts";
import { createMessageId } from "@zcode/contracts";
import { persistCompactSummary } from "../src/runtime/methods/compact-persistence.js";

describe("compact persistence model selection", () => {
  it("projects the session selection when no execution model was supplied", async () => {
    const saved: MessageInfo[] = [];
    const runtime = {
      config: { agentName: "test-agent", systemPrompt: "test" },
      getSessionModelSelection: () => ({
        providerId: "selection-provider",
        modelId: "selection-model",
        options: { reasoningLevel: "high" },
      }),
      getTools: () => [],
      persistMessage: async (message: MessageInfo) => {
        saved.push(message);
      },
      persistPart: async () => {},
      sessionId: "session-compact-selection",
      sessionStore: {},
    };

    await persistCompactSummary.call(
      runtime as never,
      createMessageId(),
      "compact content",
      "compact summary",
      {
        trigger: "manual",
        phase: "post_response",
        compactReason: "manual",
      } as never,
      { traceId: "trace-compact-selection" } as never,
    );

    expect(saved[0]).toMatchObject({
      modelSelection: {
        providerId: "selection-provider",
        modelId: "selection-model",
      },
    });
  });
});

// 通过真实 runtime + 录制 store 注入提交后的事件故障，断言活动上下文与持久化结果一致。
import {
  CompactTrigger,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingMessageStore } from "./runtime-output-token-continuation-test-helpers.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

async function committedFixture() {
  const sessionId = createSessionId();
  const store = createRecordingMessageStore();
  let summaryCalls = 0;
  const factory = createTestModelFactory({
    generateText: async (request) => ({
      finishReason: "stop",
      text: JSON.stringify(request.messages.at(-1)?.content).includes("create a detailed summary")
        ? `<summary>committed summary ${++summaryCalls}</summary>`
        : "setup response",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    }),
  });
  const config = {
    mode: "yolo" as const,
    modelStreaming: "off" as const,
    compact: { enabled: false },
    titleGeneration: { enabled: false },
    systemPrompt: "commit audit",
  };
  const eventStore = createTestSessionEventStore();
  const runtime = createTestAgentRuntime(sessionId, config, {
    eventStore,
    sessionStore: store as never,
    modelFactory: factory,
  });
  const internal = runtime as unknown as AgentRuntimeInternal;
  await runtime.executeTurn("old original prompt one");
  await runtime.executeTurn("old original prompt two");
  await runtime.executeTurn("old original prompt three");
  const bundles: import("@zcode/contracts").MessageCommitBundle[] = [];
  const commit = async (bundle: import("@zcode/contracts").MessageCommitBundle) => {
    bundles.push(structuredClone(bundle));
    for (const record of bundle.messages) {
      await store.saveMessage(record.info as never);
      for (const part of record.parts) await store.savePart(part as never);
    }
  };
  const transactionalStore = Object.assign(store, { commitMessageBundle: commit });
  return {
    sessionId,
    store: transactionalStore,
    runtime,
    internal,
    config,
    factory,
    eventStore,
    bundles,
    summaryCalls: () => summaryCalls,
  };
}

const historyText = (runtime: AgentRuntimeInternal) =>
  JSON.stringify(runtime.messageHistory.borrowReadOnlyRuntimeEntries());

describe("committed compact boundary", () => {
  it.each([
    [CompactTrigger.Manual, SessionEventType.CompactBoundary, false],
    [CompactTrigger.Auto, SessionEventType.CompactBoundary, false],
    [CompactTrigger.Manual, SessionEventType.CompactCompleted, false],
    [CompactTrigger.Auto, SessionEventType.CompactCompleted, false],
    [CompactTrigger.Auto, SessionEventType.CompactBoundary, true],
  ] as const)(
    "publishes %s %s once after partial=%s failure without regenerating",
    async (trigger, type, partial) => {
      const h = await committedFixture();
      const append = h.internal.appendEvent.bind(h.internal);
      let injected = false;
      vi.spyOn(h.internal, "appendEvent").mockImplementation(async (event, trace) => {
        if (!injected && event.type === type) {
          injected = true;
          if (partial) await append(event, trace);
          throw new Error("post-commit event failure");
        }
        await append(event, trace);
      });
      const result = await h.internal.compactActiveConversation(
        undefined,
        createRootTraceContext({ sessionId: h.sessionId }),
        [],
        { trigger },
      );
      expect(result.outcome).toBe("compacted");
      expect(result).not.toHaveProperty("syncError", expect.anything());
      expect(h.summaryCalls()).toBe(1);
      expect(h.store.savedMessages.filter((m) => m.summary)).toHaveLength(1);
      expect(historyText(h.internal)).toContain("committed summary 1");
      expect(historyText(h.internal)).not.toContain("old original prompt one");
      expect(
        h.bundles[0].messages.some((m) =>
          m.parts.some((p) => p.type === "compaction" && p.timelineStatus === "completed"),
        ),
      ).toBe(true);
      const events = await h.eventStore.getEvents(h.sessionId);
      expect(events.filter((e) => e.type === type)).toHaveLength(1);
      expect(events.some((e) => e.type === SessionEventType.CompactFailed)).toBe(false);
      const cold = createTestAgentRuntime(h.sessionId, h.config, {
        eventStore: createTestSessionEventStore(),
        sessionStore: h.store as never,
        modelFactory: h.factory,
      });
      await cold.resumeFromStore();
      expect(historyText(cold as unknown as AgentRuntimeInternal)).toContain("committed summary 1");
    },
  );

  it("returns committed entries even when boundary publication never recovers", async () => {
    const h = await committedFixture();
    const append = h.internal.appendEvent.bind(h.internal);
    vi.spyOn(h.internal, "appendEvent").mockImplementation(async (event, trace) => {
      if (event.type === SessionEventType.CompactBoundary)
        throw new Error("event store unavailable");
      await append(event, trace);
    });
    const result = await h.internal.compactActiveConversation(
      undefined,
      createRootTraceContext({ sessionId: h.sessionId }),
      [],
      { trigger: CompactTrigger.Auto },
    );
    expect(result).toMatchObject({ outcome: "compacted", syncError: expect.any(Error) });
    expect(h.summaryCalls()).toBe(1);
    expect(JSON.stringify(result.entries)).toContain("committed summary");
    expect(historyText(h.internal)).toContain("committed summary");
    expect(
      (await h.eventStore.getEvents(h.sessionId)).some(
        (e) => e.type === SessionEventType.CompactCompleted,
      ),
    ).toBe(true);
  });

  it.each(["failed", "interrupted"])(
    "repairs a legacy %s timeline from its committed boundary",
    async (status) => {
      const h = await committedFixture();
      await h.runtime.executeTurn("/compact");
      const timeline = h.store.savedParts.find(
        (p) => p.type === "compaction" && p.timelineStatus === "completed",
      );
      timeline.timelineStatus = status;
      const cold = createTestAgentRuntime(h.sessionId, h.config, {
        eventStore: createTestSessionEventStore(),
        sessionStore: h.store as never,
        modelFactory: h.factory,
      });
      const restored = await cold.resumeFromStore();
      expect(restored.persistedMessagesReloadRequired).toBe(true);
      expect(h.store.savedParts.find((p) => p.id === timeline.id).timelineStatus).toBe("completed");
      const again = await cold.resumeFromStore();
      expect(again.persistedMessagesReloadRequired).toBe(false);
    },
  );

  it.each(["auto", "reactive"] as const)(
    "installs committed request entries before stopping %s on publication failure",
    async (trigger) => {
      const h = await committedFixture();
      h.internal.config.compact = {
        enabled: true,
        contextWindow: 1,
        outputReserveTokens: 0,
        bufferTokens: 0,
      };
      const append = h.internal.appendEvent.bind(h.internal);
      vi.spyOn(h.internal, "appendEvent").mockImplementation(async (event, trace) => {
        if (event.type === SessionEventType.CompactBoundary) throw new Error("unavailable");
        await append(event, trace);
      });
      const state = {
        entries: h.internal.messageHistory.borrowReadOnlyRuntimeEntries(),
        outputTokenContinuationCount: 0,
      };
      // Use the actual configured factory binding so only the compact summary invokes a model.
      const activeModel = (await import("../src/runtime/methods/turn-model.js")).createTurnModel(
        h.internal,
      );
      const context = { model: activeModel, modelStepIndex: 1, turnRequestState: state };
      const operation =
        trigger === "auto"
          ? h.internal.autoCompactIfNeeded(
              createRootTraceContext({ sessionId: h.sessionId }),
              [],
              undefined,
              {
                ...context,
                compactReason: "context_limit",
                phase: "mid_turn",
                rapidRefill: {
                  consecutiveRapidRefills: 0,
                  shouldBlock: false,
                  toolTurnsSinceCompact: 0,
                },
              } as never,
            )
          : h.internal.reactiveCompactAfterContextExceeded(
              new Error("context overflow"),
              createRootTraceContext({ sessionId: h.sessionId }),
              [],
              undefined,
              { ...context, rapidRefillCount: 0 },
            );
      await expect(operation).rejects.toThrow("status synchronization failed");
      expect(JSON.stringify(state.entries)).toContain("committed summary");
      expect(h.internal.autoCompactConsecutiveFailures).toBe(0);
      expect(h.summaryCalls()).toBe(1);
    },
  );

  it.each(["turn-event", "projection"] as const)(
    "does not undo compact after a manual %s finalization failure",
    async (point) => {
      const h = await committedFixture();
      const append = h.internal.appendEvent.bind(h.internal);
      if (point === "turn-event")
        vi.spyOn(h.internal, "appendEvent").mockImplementation(async (event, trace) => {
          if (event.type === SessionEventType.TurnComplete)
            throw new Error("turn completion failure");
          await append(event, trace);
        });
      if (point === "projection")
        vi.spyOn(h.internal, "rebuildProjection").mockRejectedValueOnce(
          new Error("projection failure"),
        );
      await expect(h.runtime.executeTurn("/compact")).rejects.toThrow();
      expect(h.summaryCalls()).toBe(1);
      expect(historyText(h.internal)).toContain("committed summary");
      expect(
        h.store.savedParts.some((p) => p.type === "compaction" && p.timelineStatus === "completed"),
      ).toBe(true);
      expect(
        (await h.eventStore.getEvents(h.sessionId)).some(
          (event) => event.type === SessionEventType.CompactFailed,
        ),
      ).toBe(false);
    },
  );

  it("keeps a committed boundary when cancellation arrives during commit", async () => {
    const h = await committedFixture();
    const controller = new AbortController();
    const commit = h.store.commitMessageBundle.bind(h.store);
    h.store.commitMessageBundle = async (bundle) => {
      await commit(bundle);
      controller.abort("stop after commit");
    };
    const result = await h.internal.compactActiveConversation(
      undefined,
      createRootTraceContext({ sessionId: h.sessionId }),
      [],
      { abortSignal: controller.signal },
    );
    expect(result.outcome).toBe("compacted");
    expect(historyText(h.internal)).toContain("committed summary");
    expect(
      h.store.savedParts.some((p) => p.type === "compaction" && p.timelineStatus === "completed"),
    ).toBe(true);
  });

  it("keeps old history when the summary/completion transaction fails", async () => {
    const h = await committedFixture();
    const before = historyText(h.internal);
    Object.assign(h.store, {
      commitMessageBundle: async () => {
        throw new Error("bundle rollback");
      },
    });
    await expect(h.runtime.executeTurn("/compact")).rejects.toThrow();
    expect(historyText(h.internal)).toBe(before);
    expect(h.store.savedMessages.some((m) => m.summary)).toBe(false);
  });
});
