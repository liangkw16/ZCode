import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  createMessageId,
  SESSION_ENTRY_PROMPT_SNAPSHOT,
  createProjectId,
  createRootTraceContext,
  createSessionId,
  ModelErrorCode,
  type ModelInputMessage,
  type ModelRequest,
  type RuntimeInputPresentation,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { createSubagentContextBuilder } from "../src/subagent/context-builder.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { systemReminderRuntimeMetadata } from "../src/agent/message-history.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

const SUMMARY_MARKER = "create a detailed summary";
const REMINDER_PATTERN = /<total_tokens>(\d+) tokens left<\/total_tokens>/g;

/** 一次主循环响应：保留真实 usage，验证不再生成虚拟余额。 */
interface ScriptStep {
  input: number;
  output: number;
  tool?: boolean;
  /** 本次请求先报上下文超限，触发 reactive compaction 后重试同一步。 */
  exceed?: boolean;
  /** 缓存读写量。input 已经包含这两项（与 adapter 的 inputTokens 口径相同）。 */
  cacheRead?: number;
  cacheWrite?: number;
  /** 本次响应返回前送进的 guide；不带 presentation 的和信箱一样直接调 steerTurn。 */
  guides?: { input: string; inputPresentation?: RuntimeInputPresentation }[];
}

function contentText(content: ModelInputMessage["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** 请求里非前导 system 部分出现的全部提醒数值，按出现顺序。 */
function reminderValues(request: ModelRequest): number[] {
  const firstNonSystem = request.messages.findIndex((message) => message.role !== "system");
  const body = request.messages
    .slice(firstNonSystem)
    .map((message) => contentText(message.content))
    .join("\n");
  return [...body.matchAll(REMINDER_PATTERN)].map((match) => Number(match[1]));
}

function leadingSystemText(request: ModelRequest): string {
  const firstNonSystem = request.messages.findIndex((message) => message.role !== "system");
  return request.messages
    .slice(0, firstNonSystem)
    .map((message) => contentText(message.content))
    .join("");
}

function runNotificationTurn(runtime: ReturnType<typeof createTestAgentRuntime>) {
  return runtime.executeTurn("<task-notification>background done</task-notification>", undefined, {
    inputSource: "background_task",
    inputVisibility: "model-only",
    inputPresentation: "task_notification",
  });
}

async function fixture(
  options: {
    mcs?: boolean;
    taskType?: "subagent_child" | "workflow_child";
    /** 小上下文窗口：上下文接近 50000 时触发 auto compaction。 */
    smallWindow?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "total-tokens-reminder-"));
  const dbPath = join(root, "session.sqlite");
  let store = await createSqliteSessionStore({ dbPath });
  const sessionId = createSessionId("total-tokens-reminder");
  const mainRequests: ModelRequest[] = [];
  const summaryRequests: ModelRequest[] = [];
  const script: ScriptStep[] = [];
  const runtimes: ReturnType<typeof createTestAgentRuntime>[] = [];
  onTestFinished(async () => {
    for (const runtime of runtimes) await runtime.closeBrowserSession();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.createSession({
    id: sessionId,
    projectID: createProjectId("test"),
    slug: "test",
    title: "test",
    directory: root,
    version: "test",
  });
  let toolCallIndex = 0;
  const modelFactory = createTestModelFactory({
    properties: { supportsMidConversationSystem: options.mcs === true },
    async generateText(request) {
      if (JSON.stringify(request.messages).includes(SUMMARY_MARKER)) {
        summaryRequests.push(request);
        return { text: "<summary>Continue the task.</summary>", finishReason: "stop", usage: {} };
      }
      mainRequests.push(request);
      const step = script[0];
      if (!step) throw new Error("script exhausted");
      if (step.exceed) {
        step.exceed = false;
        throw Object.assign(new Error("provider context window exceeded"), {
          code: ModelErrorCode.ModelContextExceeded,
        });
      }
      script.shift();
      const runtime = runtimes.at(-1)!;
      for (const guide of step.guides ?? []) {
        const queued = await runtime.steerTurn({
          delivery: "guide",
          expectedTurnId: runtime.getActiveTurnInfo()?.turnId,
          ...guide,
        });
        expect(queued.kind).toBe("queued");
      }
      const usage = {
        inputTokens: step.input,
        outputTokens: step.output,
        totalTokens: step.input + step.output,
        ...(step.cacheRead !== undefined ? { cacheReadTokens: step.cacheRead } : {}),
        ...(step.cacheWrite !== undefined ? { cacheWriteTokens: step.cacheWrite } : {}),
      };
      if (!step.tool) return { text: "done", finishReason: "stop", usage };
      toolCallIndex += 1;
      return {
        text: "",
        finishReason: "tool-calls",
        toolCalls: [{ id: `inspect-${toolCallIndex}`, name: "Inspect", input: {} }],
        usage,
      };
    },
  });
  const makeRuntime = () => {
    const registry = createToolRegistry();
    registry.register({
      inputSchema: {},
      metadata: {
        name: "Inspect",
        concurrentSafe: true,
        destructive: false,
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => "ok",
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        maxTurns: 30,
        modelStreaming: "off",
        taskType: options.taskType,
        titleGeneration: { enabled: false },
        workspacePath: root,
        ...(options.smallWindow
          ? {
              compact: { bufferTokens: 10, contextWindow: 50_000, summaryReserveTokens: 0 },
              maxOutputTokens: 1,
            }
          : {}),
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory,
        sessionStore: store,
        toolRegistry: registry,
      },
    );
    runtimes.push(runtime);
    return { runtime, internal: runtime as unknown as AgentRuntimeInternal };
  };
  return {
    ...makeRuntime(),
    get store() {
      return store;
    },
    mainRequests,
    summaryRequests,
    script(...steps: ScriptStep[]) {
      script.push(...steps);
    },
    async reopen() {
      store.close();
      store = await createSqliteSessionStore({ dbPath });
      const next = makeRuntime();
      await next.runtime.resumeFromStore();
      return next;
    },
  };
}

function expectNoVirtualBudget(requests: ModelRequest[]) {
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(JSON.stringify(request.messages)).not.toContain("<total_tokens>");
  }
}

describe("virtual token reminders are retired", () => {
  it.each([false, true])(
    "does not generate balances through tools, turns, resume or goal continuation (MCS=%s)",
    async (mcs) => {
      const f = await fixture({ mcs });
      f.script({ input: 1000, output: 5, tool: true }, { input: 1100, output: 2 });
      await f.runtime.executeTurn("first prompt");
      const cold = await f.reopen();
      f.script({ input: 2000, output: 5, tool: true }, { input: 2100, output: 1 });
      await cold.runtime.executeTurn("continue the goal", undefined, {
        inputSource: "goal-continuation",
        inputVisibility: "model-only",
      });
      f.script({ input: 3000, output: 5, tool: true }, { input: 3100, output: 1 });
      await runNotificationTurn(cold.runtime);
      expectNoVirtualBudget(f.mainRequests);
      const history = cold.internal.messageHistory.borrowReadOnlyRuntimeEntries();
      expect(
        history.some((entry) => entry.kind !== "attachment" && entry.tokens?.input === 3000),
      ).toBe(true);
    },
  );

  it.each([false, true])(
    "preserves old system snapshots and reminders without generating more (MCS=%s)",
    async (mcs) => {
      const f = await fixture({ mcs });
      f.script({ input: 1000, output: 5 });
      await f.runtime.executeTurn("old conversation");
      const oldSystem = "Legacy system\n\n<total_tokens>15000000 tokens left</total_tokens>";
      const snapshot = (
        await f.store.sessionEntries({
          sessionID: f.internal.sessionId,
          type: SESSION_ENTRY_PROMPT_SNAPSHOT,
        })
      ).at(-1)!;
      await f.store.saveSessionEntry({
        ...snapshot,
        data: { ...f.internal.promptSnapshot!, system: [{ role: "system", content: oldSystem }] },
      });
      await f.internal.persistSyntheticUserNoticeForSession({
        messageID: createMessageId(),
        sessionId: f.internal.sessionId,
        source: "total_tokens_reminder",
        text: "<total_tokens>14998995 tokens left</total_tokens>",
        metadata: { runtimeMessage: systemReminderRuntimeMetadata("total_tokens_reminder") },
        traceContext: createRootTraceContext(),
      });
      const cold = await f.reopen();
      f.script({ input: 2000, output: 5, tool: true }, { input: 2100, output: 1 });
      await cold.runtime.executeTurn("resume old conversation");
      for (const request of f.mainRequests.slice(1)) {
        expect(leadingSystemText(request)).toBe(oldSystem);
        expect(reminderValues(request)).toEqual([14998995]);
      }
      const compact = await cold.internal.compactActiveConversation(
        undefined,
        createRootTraceContext(),
        [],
        {},
      );
      expect(compact.outcome).toBe("compacted");
      f.script({ input: 100, output: 1 });
      await cold.runtime.executeTurn("after compact");
      expect(leadingSystemText(f.mainRequests.at(-1)!)).not.toContain("<total_tokens>");
    },
  );

  it.each(["reactive", "auto"])("keeps %s compaction working without balances", async (kind) => {
    const f = await fixture({ smallWindow: kind === "auto" });
    f.script({ input: 1000, output: 5, tool: true }, { input: 1100, output: 5 });
    await f.runtime.executeTurn("build history");
    f.script(
      { input: kind === "auto" ? 49_990 : 1300, output: 5, tool: true },
      { input: 500, output: 5, tool: true, exceed: kind === "reactive" },
      { input: 600, output: 2 },
    );
    await f.runtime.executeTurn("compact during the turn");
    expect(f.summaryRequests).toHaveLength(1);
    expectNoVirtualBudget([...f.mainRequests, ...f.summaryRequests]);
  });

  it.each([
    [{ input: "mailbox note" }],
    [{ input: "user note", inputPresentation: "user_steer" as const }],
  ])("does not append a balance for text guides: %j", async (guide) => {
    const f = await fixture();
    f.script({ input: 1000, output: 5, guides: [guide] }, { input: 1100, output: 2 });
    await f.runtime.executeTurn("first prompt");
    expect(f.mainRequests).toHaveLength(2);
    expectNoVirtualBudget(f.mainRequests);
  });

  it.each(["subagent_child", "workflow_child"] as const)(
    "does not generate balances for %s",
    async (taskType) => {
      const f = await fixture({ taskType });
      f.script({ input: 1000, output: 5, tool: true }, { input: 1100, output: 2 });
      await f.runtime.executeTurn("child task");
      expectNoVirtualBudget(f.mainRequests);
    },
  );

  it("ends the subagent system after the notes", () => {
    const built = createSubagentContextBuilder({
      agentPrompt: "You are a file search specialist.",
      envInfo: {
        cwd: "/workspace",
        platform: "linux",
        shell: "bash",
        osVersion: "Linux",
        nodeVersion: "24.14.0",
        isGitRepository: false,
      },
    }).build();
    const tail = String(built.systemMessages.at(-1)?.content);
    expect(tail.endsWith("this note is about report files.)")).toBe(true);
    expect(JSON.stringify(built.systemMessages)).not.toContain("<total_tokens>");
  });
});
