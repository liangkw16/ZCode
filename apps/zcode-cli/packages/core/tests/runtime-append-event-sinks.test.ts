import { describe, expect, it } from "vitest";
import {
  createSessionEvent,
  createSessionId,
  createTurnId,
  SessionEventType,
  type SessionEvent,
  type TraceContext,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { resumeStoredSessionEventPublication } from "../src/runtime/methods/events.js";

// 修复原因：appendEvent 为收集失败的 sink 改写后，`options.sinkFailures?.push(...)` 在不传收集参数时
// 会把可选链后面的投递一起短路——事件照常落库，却不再通知任何 sink。v4 网关靠 sink 拿事件，
// 结果是模型照常运行、对话帧不再产出，新建的对话在界面上始终是空的。这里锁定“落库后必达 sink”。
describe("agent runtime appendEvent sink delivery", () => {
  const sessionId = createSessionId("session");

  function event(): SessionEvent {
    return createSessionEvent(
      SessionEventType.SessionTitleUpdated,
      sessionId,
      { previousTitle: "", source: "first_input", title: "appended" },
      { traceId: "trace-append", turnId: createTurnId("turn-append") },
    );
  }

  it("不传收集参数时，落库后的事件照常送达全部 sink", async () => {
    const eventStore = createTestSessionEventStore();
    const constructorSink: SessionEvent[] = [];
    const subscribedSink: SessionEvent[] = [];
    const runtime = new AgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        eventSink: {
          onSessionEvent: (item) => {
            constructorSink.push(item);
          },
        },
      },
    );
    runtime.subscribeEvents({
      onSessionEvent: (item) => {
        subscribedSink.push(item);
      },
    });
    const internal = runtime as unknown as {
      rootTraceContext: TraceContext;
      appendEvent(item: SessionEvent, trace: TraceContext): Promise<void>;
    };

    await internal.appendEvent(event(), internal.rootTraceContext);

    const stored = await eventStore.getEvents(sessionId);
    expect(stored).toHaveLength(1);
    // sink 拿到的是落库后带序号的同一份事件，live、replay 与 snapshot 的序号来自同一个 store。
    expect(constructorSink).toEqual(stored);
    expect(subscribedSink).toEqual(stored);
  });

  it("单个 sink 抛错不影响其余 sink，appendEvent 也不因此失败", async () => {
    const eventStore = createTestSessionEventStore();
    const received: SessionEvent[] = [];
    const runtime = new AgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        eventSink: {
          onSessionEvent: () => {
            throw new Error("sink boom");
          },
        },
      },
    );
    runtime.subscribeEvents({
      onSessionEvent: (item) => {
        received.push(item);
      },
    });
    const internal = runtime as unknown as {
      rootTraceContext: TraceContext;
      appendEvent(item: SessionEvent, trace: TraceContext): Promise<void>;
    };

    await expect(internal.appendEvent(event(), internal.rootTraceContext)).resolves.toBeUndefined();

    expect(received).toEqual(await eventStore.getEvents(sessionId));
  });

  it("续投已落库事件时不传收集参数，同样送达 sink", async () => {
    const eventStore = createTestSessionEventStore();
    const received: SessionEvent[] = [];
    const runtime = new AgentRuntime(
      sessionId,
      {},
      { eventStore, eventSink: { onSessionEvent: (item) => void received.push(item) } },
    );
    const internal = runtime as unknown as {
      rootTraceContext: TraceContext;
    };
    const stored = await eventStore.append(event());

    await resumeStoredSessionEventPublication(runtime as never, stored, internal.rootTraceContext);

    expect(received).toEqual([stored]);
  });
});
