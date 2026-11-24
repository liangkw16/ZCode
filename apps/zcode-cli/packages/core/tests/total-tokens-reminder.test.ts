import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
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
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";

// 开关默认关闭，每个 runtime 创建时从 runtimeConfig.totalTokensReminder.enabled 读一次。
// 本文件默认在新建 runtime 时打开；undefined 表示不传配置，验证缺省关闭。
const reminderSwitch: { enabled: boolean | undefined } = { enabled: true };

beforeEach(() => {
  reminderSwitch.enabled = true;
});

function reminderConfig(): { totalTokensReminder?: { enabled: boolean } } {
  return reminderSwitch.enabled === undefined
    ? {}
    : { totalTokensReminder: { enabled: reminderSwitch.enabled } };
}

const SUMMARY_MARKER = "create a detailed summary";
const REMINDER_PATTERN = /<total_tokens>(\d+) tokens left<\/total_tokens>/g;
// 开关关闭时，默认 system 的动态段以 `# Memory, notes and feedback` 段结尾。
const DEFAULT_SYSTEM_END = "work from the context, not intermediate files.";

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
        ...reminderConfig(),
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
      totalTokensReminder: true,
    }).build();
    const tail = String(built.systemMessages.at(-1)?.content);
    expect(tail.endsWith("this note is about report files.)")).toBe(true);
    expect(JSON.stringify(built.systemMessages)).not.toContain("<total_tokens>");
  });
});

/** 去掉缓存断点：断点只标在最新的消息上，会随新请求移动，不是消息内容。 */
function withoutCacheControl(messages: ModelInputMessage[]): ModelInputMessage[] {
  return messages.map(({ cacheControl: _cacheControl, ...message }) => message);
}

function hasTotalTokensText(request: ModelRequest): boolean {
  return JSON.stringify(request.messages).includes("<total_tokens>");
}

describe("total-tokens reminder off by default", () => {
  beforeEach(() => {
    // 不传配置：缺省就是关闭。
    reminderSwitch.enabled = undefined;
  });

  it.each([{ mcs: false }, { mcs: true }])(
    "adds no budget line and no reminder to a main session, also after resume %j",
    async ({ mcs }) => {
      const f = await fixture({ mcs });
      f.script(
        { input: 1000, output: 5, tool: true },
        { input: 2400, output: 7, tool: true },
        { input: 2600, output: 9 },
      );
      await f.runtime.executeTurn("first prompt");
      f.script({ input: 3000, output: 10, tool: true }, { input: 3100, output: 3 });
      await f.runtime.executeTurn("second prompt");
      const cold = await f.reopen();
      f.script({ input: 3200, output: 4, tool: true }, { input: 3300, output: 1 });
      await cold.runtime.executeTurn("after resume");

      expect(f.mainRequests).toHaveLength(7);
      for (const request of f.mainRequests) {
        expect(hasTotalTokensText(request)).toBe(false);
        expect(leadingSystemText(request).endsWith(DEFAULT_SYSTEM_END)).toBe(true);
      }
    },
  );

  it.each(["subagent_child", "workflow_child"] as const)(
    "adds no budget line and no reminder to a %s",
    async (taskType) => {
      const f = await fixture({ taskType });
      f.script({ input: 1000, output: 5, tool: true }, { input: 1100, output: 2 });
      await f.runtime.executeTurn("child task");
      expect(f.mainRequests).toHaveLength(2);
      for (const request of f.mainRequests) expect(hasTotalTokensText(request)).toBe(false);
    },
  );

  it("ends the subagent system prompt with the notes", () => {
    const built = createSubagentContextBuilder({
      agentPrompt: "You are a file search specialist.",
      envInfo: {
        cwd: "/Users/dev/project",
        platform: "darwin",
        shell: "zsh",
        osVersion: "Darwin 24.3.0",
        nodeVersion: "24.14.0",
        isGitRepository: false,
      },
    }).build();
    const tail = String(built.systemMessages.at(-1)?.content);
    expect(tail.endsWith("this note is about report files.)")).toBe(true);
    expect(JSON.stringify(built.systemMessages)).not.toContain("<total_tokens>");
  });

  it("replays stored reminders unchanged and keeps the snapshot line until the next compaction", async () => {
    // 开关打开时写下的会话：提醒已落库，prompt 快照带预算行。
    reminderSwitch.enabled = true;
    const f = await fixture();
    f.script({ input: 1000, output: 5, tool: true }, { input: 1100, output: 2 });
    await f.runtime.executeTurn("written while on");
    const lastLive = f.mainRequests.at(-1)!;
    expect(reminderValues(lastLive)).toEqual([15_000_000, 14_998_995]);

    reminderSwitch.enabled = false;
    const cold = await f.reopen();
    f.script({ input: 1200, output: 5, tool: true }, { input: 1300, output: 2 });
    await cold.runtime.executeTurn("after the switch is off");
    const resumed = f.mainRequests.slice(2);
    // 已发的提醒按原位置、原字节回放，不新增；已发的消息只追加。
    for (const request of resumed) {
      expect(reminderValues(request)).toEqual([15_000_000, 14_998_995]);
      expect(withoutCacheControl(request.messages.slice(0, lastLive.messages.length))).toEqual(
        withoutCacheControl(lastLive.messages),
      );
      // 快照里记录的预算行保留到下一次压缩，system 字节不变。
      expect(leadingSystemText(request)).toBe(leadingSystemText(lastLive));
    }

    const result = await cold.internal.compactActiveConversation(
      undefined,
      createRootTraceContext(),
      [],
      {},
    );
    expect(result.outcome).toBe("compacted");
    f.script({ input: 1400, output: 5, tool: true }, { input: 1500, output: 2 });
    await cold.runtime.executeTurn("after compaction");
    for (const request of f.mainRequests.slice(4)) {
      expect(leadingSystemText(request)).not.toContain("<total_tokens>");
      expect(leadingSystemText(request).endsWith(DEFAULT_SYSTEM_END)).toBe(true);
      expect(reminderValues(request)).toEqual([]);
    }
  });
});

describe("total-tokens reminder value per runtime", () => {
  it("keeps a snapshot without the line when turned on at resume and adds the line after compaction", async () => {
    // 关闭时写下的会话：没有提醒，prompt 快照没有预算行。
    reminderSwitch.enabled = false;
    const f = await fixture();
    f.script({ input: 1000, output: 5, tool: true }, { input: 1100, output: 2 });
    await f.runtime.executeTurn("written while off");
    const lastLive = f.mainRequests.at(-1)!;
    expect(hasTotalTokensText(lastLive)).toBe(false);

    reminderSwitch.enabled = true;
    const cold = await f.reopen();
    f.script({ input: 1200, output: 5, tool: true }, { input: 1300, output: 2 });
    await cold.runtime.executeTurn("after the switch is on");
    const resumed = f.mainRequests.slice(2);
    // 倒数提醒按当前值收集：真实消息以持久化的 usage（1102）起算，工具批次后 used = 1205 - 1102。
    expect(resumed.map(reminderValues)).toEqual([[15_000_000], [15_000_000, 14_999_897]]);
    for (const request of resumed) {
      // system 按快照原字节发送，不补预算行；已发的消息只追加。
      expect(leadingSystemText(request)).toBe(leadingSystemText(lastLive));
      expect(withoutCacheControl(request.messages.slice(0, lastLive.messages.length))).toEqual(
        withoutCacheControl(lastLive.messages),
      );
    }

    const result = await cold.internal.compactActiveConversation(
      undefined,
      createRootTraceContext(),
      [],
      {},
    );
    expect(result.outcome).toBe("compacted");
    f.script({ input: 1400, output: 5 });
    await cold.runtime.executeTurn("after compaction");
    // 压缩清掉快照，重建的 system 以预算行结尾。
    const afterCompaction = f.mainRequests.at(-1)!;
    expect(leadingSystemText(afterCompaction).endsWith(`\n\n${TOTAL_TOKENS_SYSTEM_LINE}`)).toBe(
      true,
    );
    expect(reminderValues(afterCompaction).at(-1)).toBe(15_000_000);
  });

  it.each([true, false])("a subagent follows the parent runtime value %s", async (enabled) => {
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const childRequests: ModelRequest[] = [];
    let parentCalls = 0;
    const runtime = createTestAgentRuntime(
      createSessionId(`total-tokens-child-${enabled}`),
      {
        mode: "yolo",
        workingDirectory: "/workspace/project",
        totalTokensReminder: { enabled },
        subagents: {
          profiles: [
            {
              name: "count-child",
              description: "Counts.",
              source: "project",
              systemPrompt: "Count as asked.",
              tools: ["Read"],
            },
          ],
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore: createRecordingSubagentSessionStore(),
        modelFactory: createTestModelFactory({
          async generateText(request) {
            if (!(request.tools ?? []).some((tool) => tool.name === "Agent")) {
              childRequests.push(request);
              return { text: "child done", finishReason: "stop", usage };
            }
            parentCalls += 1;
            if (parentCalls > 1) return { text: "parent done", finishReason: "stop", usage };
            return {
              text: "",
              finishReason: "tool-calls",
              toolCalls: [
                {
                  id: "call_child",
                  name: "Agent",
                  input: {
                    description: "Count",
                    prompt: "Count to three.",
                    subagent_type: "count-child",
                    run_in_background: false,
                  },
                },
              ],
              usage,
            };
          },
        }),
      },
    );
    onTestFinished(async () => {
      await runtime.closeBrowserSession();
    });
    await runtime.executeTurn("count");
    expect(childRequests).toHaveLength(1);
    expect(leadingSystemText(childRequests[0]!).includes(TOTAL_TOKENS_SYSTEM_LINE)).toBe(enabled);
  });
});
