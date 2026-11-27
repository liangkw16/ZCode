import {
  legacySyntheticRuntimeMetadata,
  systemReminderRuntimeMetadata,
  todoReminderRuntimeMetadata,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
  type RuntimeMessageMetadata,
} from "../../agent/message-history.js";
import type {
  CollaborationMode,
  OutputStylePromptConfig,
  SessionTaskType,
  SyntheticUserMessageSource,
  TodoItem,
} from "../deps.js";
import { ASK_USER_QUESTION_TOOL_NAME, EXIT_PLAN_MODE_TOOL_NAME } from "@zcode/contracts";
import { isUserTurnInput } from "./provider-entry-origins.js";

export const RUNTIME_MODE_REMINDER_CONFIG = Object.freeze({
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
});

const PLAN_MODE_ACTIVE_PREFIX = "Plan mode is active.";
const PLAN_MODE_READ_ONLY = `${PLAN_MODE_ACTIVE_PREFIX} Only take read-only actions. Do not write or edit files, change configuration, or make commits.`;

interface PlanModeReminderOptions {
  subagent?: boolean;
  askUserQuestionAvailable?: boolean;
  exitPlanModeAvailable?: boolean;
}

function buildPlanClarificationReminder(askUserQuestionAvailable: boolean): string {
  const action = askUserQuestionAvailable
    ? `use ${ASK_USER_QUESTION_TOOL_NAME}`
    : "ask the user directly";
  return `Resolve routine choices from the request, code, and reasonable defaults. Only when a necessary decision must come from the user, ${action}.`;
}

function buildMainPlanModeReminder(full: boolean, options: PlanModeReminderOptions): string {
  return [
    full ? PLAN_MODE_READ_ONLY : "Plan mode still active. Read-only; do not write or edit files.",
    ...(full
      ? [
          "Read the code needed for the task and reuse existing implementations. Keep the plan proportional to the task: state the goal, key change paths, recommended approach, and verification method.",
        ]
      : []),
    buildPlanClarificationReminder(options.askUserQuestionAvailable === true),
    options.exitPlanModeAvailable
      ? `When an implementation plan is ready for approval, call ${EXIT_PLAN_MODE_TOOL_NAME} with the complete plan in its \`plan\` parameter. The tool requests approval even if the previous mode was yolo; do not request the same approval in a separate question.`
      : "When an implementation plan is ready, show the complete plan and explain that plan mode remains active because its exit tool is unavailable. A text reply does not switch modes or authorize implementation.",
    "For a research-only task, return the findings directly; no implementation approval or final tool call is required.",
  ].join("\n\n");
}

/** 子会话只完成委派查询，不承担主会话的实现审批，也不要求再次派生 Agent。 */
function buildSubagentPlanModeReminder(askUserQuestionAvailable: boolean): string {
  return [
    PLAN_MODE_READ_ONLY,
    "Answer the delegated query comprehensively using read-only actions.",
    ...(askUserQuestionAvailable ? [buildPlanClarificationReminder(true)] : []),
  ].join("\n\n");
}

const PLAN_MODE_EXIT_REMINDER = [
  "## Exited Plan Mode",
  "",
  `You have exited plan mode. You can now make edits, run tools, and take actions.`,
];

export const TODO_REMINDER_CONFIG = Object.freeze({
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
});

// 静默提醒按时间判定，所有模型相同，每段不设上限（meta-user-context.md「Silent-turn reminder」）。
const SILENT_TURN_REMINDER_MS = 60_000;
const SILENT_TURN_REMINDER_BODY =
  "The user hasn't heard from you in a while. As you continue, keep them updated when there's something to tell — a finding, a change of plan.";
// 只有空白或这些占位文字的 assistant 文本不算与用户沟通。
const SILENT_TURN_PLACEHOLDER_TEXTS: ReadonlySet<string> = new Set([
  "(no content)",
  "No response requested.",
]);

function isVisibleAssistantText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !SILENT_TURN_PLACEHOLDER_TEXTS.has(trimmed);
}

/**
 * 最近一次提醒之后至少一次静默响应，且距锚点满 60 秒时返回提醒正文。锚点是倒扫时遇到的第一个
 * 静默提醒、有效沟通的响应或用户轮次（三者中最新的一个），找到就停；锚点没有时间时不发。
 * nowMs 是收集时的时钟。
 */
export function buildSilentTurnReminderBody(
  entries: readonly RuntimeMessageEntry[],
  nowMs: number,
): string | null {
  let silentTurns = 0;
  let anchor: RuntimeMessageEntry | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.metadata?.source === "silent_turn_reminder") {
      anchor = entry;
      break;
    }
    if (isRuntimeAttachmentEntry(entry)) continue;
    const { message } = entry;
    // 新的用户轮次结束静默段：新轮通知、中断标记与 compact summary 也算。
    // 中途输入（user_steer 等，含旧版本存下的立即发送）不算，不结束静默段，也不改锚点。
    if (isUserTurnInput(entry)) {
      anchor = entry;
      break;
    }
    if (message.role !== "assistant") continue;
    const communicated =
      typeof message.content === "string"
        ? isVisibleAssistantText(message.content)
        : message.content.some(
            (block) => block.type === "text" && isVisibleAssistantText(block.text),
          );
    if (
      communicated ||
      message.toolCalls?.some(
        (call) =>
          call.name === ASK_USER_QUESTION_TOOL_NAME || call.name === EXIT_PLAN_MODE_TOOL_NAME,
      )
    ) {
      anchor = entry;
      break;
    }
    // 每个已提交 assistant entry 是一次模型响应；工具数量和工具结果都不增加轮次。
    silentTurns++;
  }
  if (silentTurns === 0 || anchor?.time === undefined) return null;
  return nowMs - anchor.time >= SILENT_TURN_REMINDER_MS ? SILENT_TURN_REMINDER_BODY : null;
}

export interface TodoReminderTurnCounts {
  turnsSinceLastTodoWrite: number;
  turnsSinceLastReminder: number;
}

export function buildDateChangeReminderBody(currentDate: string): string {
  return `The date has changed. Today's date is now ${currentDate}. No need to announce the new date — the user's own clock shows it.`;
}

export function runtimeMetadataForSyntheticUserMessageSource(
  source: SyntheticUserMessageSource,
): RuntimeMessageMetadata {
  if (
    source === "background_task" ||
    source === "subagent_message" ||
    source === "shared_context"
  ) {
    return legacySyntheticRuntimeMetadata();
  }
  if (source === "subagent") {
    return systemReminderRuntimeMetadata("queued_system_notification");
  }
  if (source === "todo_reminder") {
    return todoReminderRuntimeMetadata();
  }
  if (source === "goal_state_change") {
    return systemReminderRuntimeMetadata("goal_state_change");
  }
  if (source === "agent_listing_delta") {
    return systemReminderRuntimeMetadata(source);
  }
  if (source === "plugin_reference") {
    return systemReminderRuntimeMetadata("plugin_reference");
  }
  if (source === "selection_side_chat") {
    return systemReminderRuntimeMetadata("selection_side_chat");
  }
  if (source === "bot_topic_context") return systemReminderRuntimeMetadata("bot_topic_context");
  if (source === "goal-continuation") {
    return systemReminderRuntimeMetadata("target_continuation");
  }
  return systemReminderRuntimeMetadata("rewind_notice");
}

export function getTodoReminderTurnCounts(
  entries: readonly RuntimeMessageEntry[],
): TodoReminderTurnCounts {
  let assistantTurnsAfterCurrentEntry = 0;
  let turnsSinceLastTodoWrite: number | undefined;
  let turnsSinceLastReminder: number | undefined;

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (turnsSinceLastReminder === undefined && entry.metadata?.source === "todo_reminder") {
      turnsSinceLastReminder = assistantTurnsAfterCurrentEntry;
    }
    if (turnsSinceLastTodoWrite !== undefined && turnsSinceLastReminder !== undefined) {
      break;
    }

    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role !== "assistant") continue;
    // 思考块会单独进入历史；只跳过纯思考，避免提前触发提醒，也不漏计带工具调用的消息。
    if (
      Array.isArray(entry.message.content) &&
      entry.message.content.every((block) => block.type === "reasoning") &&
      !entry.message.toolCalls?.length
    ) {
      continue;
    }

    if (
      turnsSinceLastTodoWrite === undefined &&
      entry.message.toolCalls?.some((toolCall) => toolCall.name === "TodoWrite")
    ) {
      turnsSinceLastTodoWrite = assistantTurnsAfterCurrentEntry;
    }
    assistantTurnsAfterCurrentEntry++;
    if (turnsSinceLastTodoWrite !== undefined && turnsSinceLastReminder !== undefined) {
      break;
    }
  }

  return {
    turnsSinceLastReminder: turnsSinceLastReminder ?? assistantTurnsAfterCurrentEntry,
    turnsSinceLastTodoWrite: turnsSinceLastTodoWrite ?? assistantTurnsAfterCurrentEntry,
  };
}

export function shouldBuildTodoReminder(entries: readonly RuntimeMessageEntry[]): boolean {
  const counts = getTodoReminderTurnCounts(entries);
  return (
    counts.turnsSinceLastTodoWrite >= TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE &&
    counts.turnsSinceLastReminder >= TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS
  );
}

export function buildTodoReminderBody(todos: readonly TodoItem[]): string {
  const lines = [
    "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.",
    "",
  ];
  if (todos.length > 0) {
    const currentTodos = `[${formatTodoListForReminder(todos).join("\n")}]`;
    lines.push("", "Here are the existing contents of your todo list:", "", currentTodos);
  }
  return lines.join("\n");
}

/**
 * Plan 提醒按会话类型选择正文；轮内收集与 compact 后重发共用，避免一处漏掉子会话。
 * tools 传请求曝光前的完整候选表（含 deferred），不能拿 surfaced schemas 判断能力缺席。
 */
export function buildRuntimeModeReminderBodyForTask(
  entries: readonly RuntimeMessageEntry[],
  input: {
    mode: CollaborationMode;
    planEnabled: boolean;
    taskType: SessionTaskType | undefined;
    tools: readonly { name: string }[];
  },
): string | null {
  return buildRuntimeModeReminderBody(entries, input.mode, input.planEnabled, {
    subagent: input.taskType === "subagent_child",
    askUserQuestionAvailable: input.tools.some((tool) => tool.name === ASK_USER_QUESTION_TOOL_NAME),
    exitPlanModeAvailable: input.tools.some((tool) => tool.name === EXIT_PLAN_MODE_TOOL_NAME),
  });
}

export function buildRuntimeModeReminderBody(
  entries: readonly RuntimeMessageEntry[],
  mode: CollaborationMode,
  planEnabled = mode === "plan",
  options: PlanModeReminderOptions = {},
): string | null {
  if (!planEnabled) return null;

  const { foundRuntimeModeReminder, humanTurnsSinceReminder } =
    getRuntimeModeReminderTurnCount(entries);
  if (
    foundRuntimeModeReminder &&
    humanTurnsSinceReminder < RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS
  ) {
    return null;
  }

  // 修复原因：旧提醒虚构用户意图、强制五阶段与工具收尾，且未按主/子会话的实际能力降级。
  if (options.subagent) {
    return buildSubagentPlanModeReminder(options.askUserQuestionAvailable === true);
  }

  const nextReminderCount = countRuntimeModeReminders(entries) + 1;
  const full =
    nextReminderCount % RUNTIME_MODE_REMINDER_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS === 1;
  return buildMainPlanModeReminder(full, options);
}

export function buildPlanModeExitReminderBody(): string {
  return PLAN_MODE_EXIT_REMINDER.join("\n");
}

/** 当前计划段（最近一次退出之后）里是否已有完整的 plan 提醒。 */
export function hasFullRuntimeModeReminder(entries: readonly RuntimeMessageEntry[]): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.metadata?.source === "plan_mode_exit") return false;
    if (
      isRuntimeAttachmentEntry(entry) &&
      entry.metadata.source === "runtime_mode" &&
      // 旧会话的完整提醒使用同一前缀；保留段原文不重写，也不因模板升级重复注入。
      entry.content.startsWith(PLAN_MODE_ACTIVE_PREFIX)
    ) {
      return true;
    }
  }
  return false;
}

export const OUTPUT_STYLE_RESET_REMINDER =
  "The output style was reset to the default. Respond in your usual style.";

/** output style 指令正文；prompt 为空白时视为未设置。 */
export function buildOutputStyleInstructionsBody(
  outputStyle: OutputStylePromptConfig | undefined,
): string | null {
  const activePrompt = outputStyle?.prompt.trim();
  if (!outputStyle || !activePrompt) return null;
  return `# Output Style: ${outputStyle.name}\n${activePrompt}`;
}

export function buildRuntimeOutputStyleReminderBody(
  outputStyle: OutputStylePromptConfig | undefined,
): string | null {
  const activePrompt = outputStyle?.prompt.trim();
  if (!outputStyle || !activePrompt) {
    return null;
  }

  return `${outputStyle.name} output style is active. Remember to follow the specific guidelines for this style.`;
}

/** 回复语言设置被清空时的清除公告；与 output style 的重置同一形态。 */
export const LANGUAGE_CLEARED_REMINDER =
  "The language preference was cleared. Match the user's language.";

const LANGUAGE_REMINDER_HEAD = "# Language\nAlways respond in ";

/**
 * 回复语言公告正文；language 是用户在设置里输入的原文（docs/i18n/agent-reply-language.md）。
 * 插入前转义：用户输入不能破坏 <system-reminder> 标签，也不能换行插入额外的段落。
 */
export function buildLanguageReminderBody(language: string): string {
  return languageReminderBody(escapeLanguage(language));
}

/**
 * 由公告正文找回（已转义的）语言。语言在正文里出现三次，模板其余部分固定，所以能由长度反推；
 * 再用它重建正文，逐字相等才算。附件 metadata 只有来源名，不另存语言。不是公告正文时返回 undefined。
 */
export function languageOfReminderBody(body: string): string | undefined {
  const languageLength = (body.length - languageReminderBody("").length) / 3;
  if (!Number.isInteger(languageLength) || languageLength <= 0) return undefined;
  const start = LANGUAGE_REMINDER_HEAD.length;
  const language = body.slice(start, start + languageLength);
  return languageReminderBody(language) === body ? language : undefined;
}

// & < > 转命名实体，控制字符（\p{Cc} 即 U+0000–U+001F、U+007F–U+009F）与 U+2028/2029 转数字实体；引号不转。
function escapeLanguage(language: string): string {
  return language
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\p{Cc}\u2028\u2029]/gu, (char) => `&#${char.charCodeAt(0)};`);
}

function languageReminderBody(language: string): string {
  return [
    `${LANGUAGE_REMINDER_HEAD}${language}. Use ${language} for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.`,
    `Maintain full orthographic correctness for ${language}, including all required diacritical marks, accents, and special characters. Never substitute accented characters with their ASCII equivalents (e.g., never write "nao" for "não", "fur" for "für", or "loeschen" for "löschen").`,
  ].join("\n");
}

function formatTodoListForReminder(todos: readonly TodoItem[]): string[] {
  return todos.map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`);
}

function getRuntimeModeReminderTurnCount(entries: readonly RuntimeMessageEntry[]): {
  foundRuntimeModeReminder: boolean;
  humanTurnsSinceReminder: number;
} {
  let humanTurnsSinceReminder = 0;
  // 修复原因：轮首收集时本轮 prompt 已在历史里，直接计入会让提醒比应有的早一轮。
  // 本轮 prompt 在模型回应之前不计入，工具批次之后的收集才计入。
  let skipUnansweredPrompt = true;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    // 退出前的间隔不属于新一段计划模式，否则立即重进会缺失完整提醒。
    if (entry.metadata?.source === "plan_mode_exit") break;
    if (entry.metadata?.source === "runtime_mode") {
      return { foundRuntimeModeReminder: true, humanTurnsSinceReminder };
    }
    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role === "assistant") skipUnansweredPrompt = false;
    // 修复原因：中途 steer 也带 real_user 来源，算成用户轮次会让提醒发得过早；
    // 中途输入不计入。新轮通知、中断标记与 compact summary 计入，与静默段同一判定。
    if (isUserTurnInput(entry)) {
      if (skipUnansweredPrompt) skipUnansweredPrompt = false;
      else humanTurnsSinceReminder++;
    }
  }
  return { foundRuntimeModeReminder: false, humanTurnsSinceReminder };
}

function countRuntimeModeReminders(entries: readonly RuntimeMessageEntry[]): number {
  let count = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const source = entries[index]!.metadata?.source;
    // 完整／简短周期也必须在同一个退出边界重置，不能沿用旧周期。
    if (source === "plan_mode_exit") break;
    if (source === "runtime_mode") count++;
  }
  return count;
}
