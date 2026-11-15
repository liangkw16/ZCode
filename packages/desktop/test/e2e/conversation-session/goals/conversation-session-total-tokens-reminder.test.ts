// TT01–TT10 虚拟 token 余额移除（docs/conversation-session-case-catalog.md「token 预算提醒」）。
// 规格见 apps/zcode-cli/docs/design/v2/loop/meta-user-context.md「Total-tokens reminder」。
// 所有断言读取上游请求体；保留真实 usage fixture，以验证工具、续写和 Compact 控制流。
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared/test-ids";
import {
  clearAppData,
  DEFAULT_WORKSPACE,
  setInputValueByTestIdDom,
} from "#e2e/helpers/desktop-app";
import { getUpstreamRequestEvidence } from "#e2e/helpers/conversation-session-network";
import { ensureReadonlyToolFixtureFile } from "#e2e/helpers/conversation-session-readonly-tool";
import { refreshSeededOpenAIProvidersThroughSettings } from "#e2e/helpers/custom-openai-provider";
import { seedCustomOpenAIChatCompletionsProvider } from "#e2e/helpers/custom-openai-provider-store";
import { prepareIncomingMessageCapability } from "#e2e/helpers/incoming-message-capability";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";
import { startDraftFromProject } from "#e2e/helpers/project-sidebar";
import {
  LEGACY_TOTAL_TOKENS_LINE as LINE,
  blocksOf,
  totalTokensReminders,
} from "#e2e/helpers/total-tokens-evidence";
import { selectUpstreamProviderModelById } from "#e2e/helpers/upstream-provider";
import {
  clickV4Send,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4CompactMarker,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "#e2e/helpers/v4-conversation";

type Block = Record<string, unknown> & { type?: string };
type Message = { role: string; content: unknown };
type Request = { messages: Message[]; system?: unknown };

describe("TT 虚拟 token 余额移除", () => {
  before(async () => {
    await ensureReadonlyToolFixtureFile();
  });
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  for (const mcs of [true, false]) {
    const M = mcs ? "MCS" : "PLAIN";
    const id = (step: number) => `tt-a${step}-${M.toLowerCase()}`;

    it(`TT01–TT04 ${M}：新会话、工具批次、跨轮、输出续写与冷恢复均不生成余额`, async function () {
      this.timeout(480_000);
      await prepareIncomingMessageCapability(mcs);

      await runTurn(`E2E_TT_A1_${M} Read the readonly fixture twice.`, `TT_A1_DONE_${M}`);
      const sessionId = await idleSessionId("A 第一轮没有完成");
      await runTurn(`E2E_TT_A2_${M} Read it once more.`, `TT_A2_DONE_${M}`);
      await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
      await selectV4TaskById(sessionId, 30_000);
      await waitForV4TimelineContaining(`TT_A2_DONE_${M}`);
      await runTurn(`E2E_TT_A3_${M} Read it after resume.`, `TT_A3_DONE_${M}`);

      const requests = await requestsByFixture([1, 2, 3, 4, 5, 6, 7, 8].map(id));
      expectNoVirtualBalance(requests);
      // 冷恢复继续使用已持久化的默认 system，不补写旧版虚拟余额。
      expect(systemText(requests[6]!)).toBe(systemText(requests[5]!));
    });
  }

  it("TT05–TT07：auto、manual 与 reactive compact 保留真实控制流且不生成余额", async function () {
    this.timeout(480_000);
    await prepareIncomingMessageCapability(true);

    // 第二个请求的 usage 是 975000/7，超过 MCS 模型 1000000 窗口的自动压缩阈值。
    await runTurn("E2E_TT_C1 Read the readonly fixture three times.", "TT_C1_DONE");
    await waitForV4CompactMarker({ origin: "auto", status: "success" }, 90_000);
    await idleSessionId("C 第一轮没有完成");
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", {
      timeout: 15_000,
      timeoutMsg: "composer 输入框没有出现",
    });
    await clickV4Send();
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90_000);
    await idleSessionId("手动 compact 后没有回到空闲态");
    await runTurn("E2E_TT_C2 Read it after the manual compact.", "TT_C2_DONE");
    // 工具批次之后的请求返回 prompt is too long，reactive compaction 后重试。
    await runTurn("E2E_TT_C3 Read it before the reactive compact.", "TT_C3_DONE");

    const ids = ["tt-c1", "tt-c2", "tt-c3", "tt-c4", "tt-c5", "tt-c6", "tt-c7", "tt-c8-too-long"];
    const requests = await requestsByFixture([...ids, "tt-c-reactive-summary", "tt-c9", "tt-c10"]);
    expectNoVirtualBalance(requests);
  });

  it("TT08：父子 agent、工具批次和后台通知续跑均不生成余额", async function () {
    this.timeout(300_000);
    await prepareIncomingMessageCapability(true);

    await sendV4Prompt("E2E_TT_S_PARENT Explore the readonly fixture in a subagent.");
    await waitForV4TimelineContaining("TT_S_PARENT_DONE", 120_000);
    await idleSessionId("S 通知轮没有完成");

    const [parentAgent, child1, child2, parentLaunched, parentNotified] = await requestsByFixture([
      "tt-s-parent-agent",
      "tt-s-child-1",
      "tt-s-child-2",
      "tt-s-parent-launched",
      "tt-s-parent-notified",
    ]);
    expectNoVirtualBalance([parentAgent!, child1!, child2!, parentLaunched!, parentNotified!]);
  });

  it("TT09：冷恢复原样保留旧 system 余额，compact 后重建默认 system 且不追加余额", async function () {
    this.timeout(360_000);
    await prepareIncomingMessageCapability(true);

    await runTurn("E2E_TT_N1 hello.", "TT_N1_DONE");
    const sessionId = await idleSessionId("N 首轮没有完成");
    // 应用退出后播种迁移前快照：升级不回写旧字节，直到既有 Compact 边界才重建。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => seedLegacySnapshotLine(sessionId),
    });
    await selectV4TaskById(sessionId, 30_000);
    await waitForV4TimelineContaining("TT_N1_DONE");
    await runTurn("E2E_TT_N2 hello again.", "TT_N2_DONE");
    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "/compact", {
      timeout: 15_000,
      timeoutMsg: "composer 输入框没有出现",
    });
    await clickV4Send();
    await waitForV4CompactMarker({ origin: "manual", status: "success" }, 90_000);
    await idleSessionId("N 手动 compact 后没有回到空闲态");
    await runTurn("E2E_TT_N3 after compact.", "TT_N3_DONE");

    const [n1, n2, n3] = await requestsByFixture(["tt-n1", "tt-n2", "tt-n3"]);
    expectNoVirtualBalance([n1!, n3!]);
    expect(systemText(n2!)).toBe(`${systemText(n1!)}\n\n${LINE}`);
    expect(totalTokensReminders(n2!)).toEqual([]);
  });

  it("TT10：openai chat completions 的 system、工具批次和跨轮请求均不生成余额", async function () {
    this.timeout(300_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    await seedCustomOpenAIChatCompletionsProvider({
      modelId: OA_MODEL_ID,
      providerId: OA_PROVIDER_ID,
      providerName: OA_PROVIDER_NAME,
    });
    await refreshSeededOpenAIProvidersThroughSettings([OA_PROVIDER_NAME], {
      workspacePath: DEFAULT_WORKSPACE,
    });
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await selectUpstreamProviderModelById(OA_MODEL_ID, {
      includePlainModelFallback: false,
      providerId: OA_PROVIDER_ID,
      providerName: OA_PROVIDER_NAME,
    });

    await runTurn("E2E_TT_O1 Read the readonly fixture.", "TT_O1_DONE");
    await runTurn("E2E_TT_O2 hello again.", "TT_O2_DONE");

    const requests = await requestsByFixture(["tt-o1", "tt-o2", "tt-o3"]);
    expectNoVirtualBalance(requests);
  });
});

const OA_MODEL_ID = "e2e-tt-openai-model";
const OA_PROVIDER_ID = "e2e-tt-openai-provider";
const OA_PROVIDER_NAME = "Total Tokens Chat Completions";

async function runTurn(prompt: string, done: string) {
  await sendV4Prompt(prompt);
  await waitForV4TimelineContaining(done, 120_000);
  await idleSessionId(`${prompt.split(" ")[0]} 没有完成`);
}

async function idleSessionId(timeoutMsg: string): Promise<string> {
  const snapshot = await waitForV4Pane(
    (current) => Boolean(current.sessionId && current.sessionId !== "draft") && !current.canStop,
    timeoutMsg,
    120_000,
  );
  return snapshot.sessionId!;
}

/** 按 fixture id 取上游请求；每个 fixture 只匹配一次。 */
async function requestsByFixture(ids: string[]): Promise<Request[]> {
  const records = await getUpstreamRequestEvidence({});
  return ids.map((fixtureId) => {
    const record = records.find((item) => item.fixtureId === fixtureId);
    const request = record?.requestJson as Request | undefined;
    if (!request || !Array.isArray(request.messages)) throw new Error(`${fixtureId} 没有上游请求`);
    return request;
  });
}

function expectNoVirtualBalance(requests: Request[]) {
  for (const request of requests) {
    expect(systemText(request)).not.toContain("<total_tokens>");
    expect(totalTokensReminders(request)).toEqual([]);
  }
}

function systemText(request: Request): string {
  if (Array.isArray(request.system)) {
    return (request.system as Block[]).map((block) => String(block.text ?? "")).join("\u0000");
  }
  if (typeof request.system === "string") return request.system;
  const first = request.messages[0];
  return first?.role === "system"
    ? blocksOf(first.content)
        .map((b) => String(b.text ?? ""))
        .join("")
    : "";
}

// 仅测试播种旧快照。node:sqlite 只提供同步接口；调用时应用已退出，没有并发写入。
function seedLegacySnapshotLine(sessionId: string) {
  const home = process.env.ZCODE_E2E_HOME_DIR;
  if (!home) throw new Error("缺少 ZCODE_E2E_HOME_DIR");
  const database = new DatabaseSync(join(home, ".zcode", "cli", "db", "db.sqlite"));
  try {
    const id = `${sessionId}:runtime-prompt-snapshot`;
    const row = database.prepare("select data from session_entry where id = ?").get(id) as
      | { data: string }
      | undefined;
    if (!row) throw new Error(`没有 ${id}`);
    const snapshot = JSON.parse(row.data) as { system: Message[] };
    const lastSystem = snapshot.system.at(-1);
    if (!lastSystem || typeof lastSystem.content !== "string")
      throw new Error("快照末尾不是预期的 system 文本");
    if (row.data.includes("<total_tokens>")) throw new Error("新快照意外含旧余额");
    lastSystem.content += `\n\n${LINE}`;
    database
      .prepare("update session_entry set data = ? where id = ?")
      .run(JSON.stringify(snapshot), id);
  } finally {
    database.close();
  }
}
