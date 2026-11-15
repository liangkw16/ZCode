import {
  COMPACT_PROMPT_TOO_LONG_USER_MESSAGE,
  CoreErrorType,
  SessionEventType,
  isCoreError,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  createCoreError,
  formatCompactSummary,
  traceContextToLogContext,
} from "../deps.js";
import type {
  CompactTimelinePayload,
  AutoCompactPolicyConfig,
  ModelSelection,
  CompactTrigger,
  Model,
  SessionEvent,
  ToolSearchMode,
  TraceContext,
} from "../deps.js";
import {
  buildProviderRequestMessages,
  selectCompactEntries,
  selectCompactEntriesForInitialPromptTooLong,
  createModelContextExceededFinishError,
  isContextExceededFinishReason,
  readRawFinishReason,
} from "../helpers/index.js";
import type { RuntimeModelTextResult, RunModelTextRequestOptions } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { CompactRecentPreservationPolicy } from "../helpers/index.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";
import { resumeStoredSessionEventPublication } from "./events.js";

const COMPACT_SUMMARY_OUTPUT_LIMIT_REASON = "compact_summary_output_limit";

export function isCompactSummaryOutputLimitError(error: unknown): boolean {
  return isCoreError(error) && error.context?.reason === COMPACT_SUMMARY_OUTPUT_LIMIT_REASON;
}

export const COMPACT_SUMMARY_OUTPUT_RETRY_PROMPT =
  "The previous summary exceeded the output limit. Rewrite the complete handoff substantially more concisely. Preserve the current goal, constraints, evidence gaps, and next action; omit repeated history and long excerpts.";

export function createCompactSummaryOutputLimitError(result: RuntimeModelTextResult): Error {
  return createCoreError(
    CoreErrorType.ModelError,
    "Compact summary exceeded the output limit; the original history was preserved.",
    {
      context: {
        reason: COMPACT_SUMMARY_OUTPUT_LIMIT_REASON,
        finishReason: result.finishReason,
        rawFinishReason: readRawFinishReason(result.providerMetadata),
      },
      recoverable: true,
      retryable: false,
    },
  );
}

export const COMPACT_TOOL_USE_DENIAL_MESSAGE = "Tool use is not allowed during compaction";
export const COMPACT_TOOL_USE_DENIAL_REASON = "compaction agent should only produce text summary";

// 会话 toolSearch mode 是主模型的能力契约；compact 摘要请求可能路由到独立摘要模型
// （跨 provider），直接沿用 native/local 会在请求构造前抛错（resolveToolSearchMode 对
// native 要求 protocolSupported、对 local 要求 supportsToolCall）并阻断压缩。
// 降级为 auto：按目标模型能力解析（native → local → off），保证不抛错。
// exposure 侧两个 throw 条件若变化，此处的降级判断需同步。
export function coerceToolSearchModeForModel(
  mode: ToolSearchMode | undefined,
  model: Model,
): ToolSearchMode {
  if (mode === "native" && !model.requestCapabilities?.toolSearch?.protocolSupported) {
    return "auto";
  }
  if (mode === "local" && !model.properties.supportsToolCall) {
    return "auto";
  }
  return mode ?? "off";
}

export function createCompactPromptTooLongError(options: {
  attempt: number;
  cause?: unknown;
  preCompactTokenCount: number;
}): Error {
  return createCoreError(CoreErrorType.ModelContextExceeded, COMPACT_PROMPT_TOO_LONG_USER_MESSAGE, {
    cause: options.cause instanceof Error ? options.cause : undefined,
    context: {
      compactPromptTooLongAttempts: options.attempt,
      preCompactTokenCount: options.preCompactTokenCount,
    },
    recoverable: true,
    // 修复原因：compact 内部已经完成最多 3 次旧轮次截断重试；
    // 最终仍超窗时不能再被 auto compact 外层重试放大成 3x3。
    retryable: false,
  });
}

export function createCompactContextExceededFinishError(
  result: RuntimeModelTextResult,
): Error | undefined {
  const rawFinishReason = readRawFinishReason(result.providerMetadata);
  if (!isContextExceededFinishReason(result.finishReason, rawFinishReason)) {
    return undefined;
  }

  return createModelContextExceededFinishError({
    finishReason: result.finishReason,
    rawFinishReason,
  });
}

export async function persistCompactTimelineEvent(
  runtime: AgentRuntimeInternal,
  type: SessionEventType,
  payload: CompactTimelinePayload,
  traceContext: TraceContext,
  events: SessionEvent[],
): Promise<void> {
  await runtime.persistCompactTimeline(payload, traceContext);
  const event = runtime.createEvent(type, payload, traceContext);
  await runtime.appendEvent(event, traceContext);
  events.push(event);
}

export function buildCompactSummaryRequestMessages(
  entriesForSummary: readonly RuntimeMessageEntry[],
  compactPrompt: string,
  options: {
    useMidConversationSystem?: boolean;
    foldRemindersIntoToolResults?: boolean;
    dropReasoningOnlyOrBlankAssistants?: boolean;
    loadedToolCallIds?: ReadonlySet<string>;
  } = {},
): RunModelTextRequestOptions["messages"] {
  return buildProviderRequestMessages({
    entries: [...entriesForSummary, { message: { role: "user" as const, content: compactPrompt } }],
    applyCacheControl: true,
    skipCacheWrite: true,
    useMidConversationSystem: options.useMidConversationSystem,
    foldRemindersIntoToolResults: options.foldRemindersIntoToolResults,
    dropReasoningOnlyOrBlankAssistants: options.dropReasoningOnlyOrBlankAssistants,
    loadedToolCallIds: options.loadedToolCallIds,
  }).messages;
}

export function formatCompactSummaryOrThrow(
  runtime: AgentRuntimeInternal,
  result: RuntimeModelTextResult,
): string {
  const compactToolCalls = runtime.extractToolCallsFromResult(result);
  if (compactToolCalls.length > 0) {
    throw createCoreError(CoreErrorType.ModelError, COMPACT_TOOL_USE_DENIAL_MESSAGE, {
      context: {
        behavior: "deny",
        decisionReason: {
          reason: COMPACT_TOOL_USE_DENIAL_REASON,
          type: "other",
        },
        toolNames: compactToolCalls.map((toolCall) => toolCall.name),
      },
      recoverable: true,
      retryable: false,
    });
  }

  const summary = formatCompactSummary(result.text);
  if (!summary) {
    throw createCoreError(CoreErrorType.ModelError, "Failed to generate compact summary", {
      recoverable: true,
      retryable: true,
    });
  }
  return summary;
}

/** 提交后的通知最多补投一次；每个事件独立处理，失败不撤销已保存的 compact。 */
export async function publishCommittedCompactEvents(
  runtime: AgentRuntimeInternal,
  pending: readonly SessionEvent[],
  trace: TraceContext,
  events: SessionEvent[],
  operationId: string,
): Promise<Error | undefined> {
  let failure: Error | undefined;
  for (const event of pending) {
    try {
      try {
        await runtime.appendEvent(event, trace);
      } catch {
        const stored = (await runtime.eventStore.getEvents(runtime.sessionId)).find(
          (item) => item.id === event.id,
        );
        if (stored) await resumeStoredSessionEventPublication(runtime, stored, trace);
        else await runtime.appendEvent(event, trace);
      }
      events.push(event);
    } catch (error) {
      failure ??= createCoreError(
        CoreErrorType.ModelError,
        "Context compacted, but status synchronization failed.",
        {
          cause: error instanceof Error ? error : undefined,
          context: { reason: "compact_sync_failed", sessionEventType: event.type, operationId },
          recoverable: true,
          retryable: false,
        },
      );
      runtime.logger?.warn("Committed compact event publication failed", {
        ...traceContextToLogContext(trace),
        event: "compact.committed_event.failed",
        operationId,
        sessionEventType: event.type,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return failure;
}

export function capCompactSummaryMaxOutputTokens(
  model: Model,
  config: AutoCompactPolicyConfig | undefined,
): number {
  const configured = config?.summaryMaxOutputTokens;
  const summaryCap =
    typeof configured === "number" && Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : MAX_OUTPUT_TOKENS_FOR_SUMMARY;
  // Compact 是独立执行链，在这里显式选择模型上限与 summary 上限中的较小值。
  const desired = Math.min(
    resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: model.optionSpecs.maxOutputTokens.max,
    }),
    summaryCap,
  );
  return Math.min(desired, model.optionSpecs.maxOutputTokens.max);
}

export function resolveCompactRecentPreservationPolicy(
  config: AutoCompactPolicyConfig | undefined,
): CompactRecentPreservationPolicy | undefined {
  if (config?.keepRecentTokens === undefined && config?.keepRecentRounds === undefined) {
    return undefined;
  }
  return {
    ...(config?.keepRecentRounds !== undefined
      ? { keepRecentRounds: config.keepRecentRounds }
      : {}),
    ...(config?.keepRecentTokens !== undefined
      ? { keepRecentTokens: config.keepRecentTokens }
      : {}),
  };
}

export function selectInitialCompactEntriesForActiveConversation(input: {
  activeEntries: readonly RuntimeMessageEntry[];
  initialPromptTooLongCause?: unknown;
  preserveRecent?: CompactRecentPreservationPolicy;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
}) {
  const baseSelection = selectCompactEntries({
    entries: input.activeEntries,
    ...(input.preserveRecent ? { preserveRecent: input.preserveRecent } : {}),
    trigger: input.trigger,
  });
  if (input.initialPromptTooLongCause === undefined) {
    return baseSelection;
  }

  return (
    selectCompactEntriesForInitialPromptTooLong({
      entries: input.activeEntries,
      promptTooLongCause: input.initialPromptTooLongCause,
      ...(input.preserveRecent ? { preserveRecent: input.preserveRecent } : {}),
      trigger: input.trigger,
      useMidConversationSystem: input.useMidConversationSystem,
    }) ?? baseSelection
  );
}

export function resolveCompactSummaryModelSelection(
  config: AutoCompactPolicyConfig | undefined,
): ModelSelection | undefined {
  const providerId = config?.summaryProvider?.trim();
  const modelId = config?.summaryModel?.trim();
  if (!providerId || !modelId) return undefined;
  return { providerId, modelId };
}

/** 截断请求同样消耗真实用量；只发计量事件，不把半截文字保存成有效摘要。 */
export async function recordCompactModelCompletion(
  runtime: AgentRuntimeInternal,
  result: RuntimeModelTextResult,
  content: string,
  trace: TraceContext,
  events: SessionEvent[],
): Promise<void> {
  const event = runtime.createEvent(
    SessionEventType.ModelComplete,
    {
      content,
      stopReason: result.finishReason,
      usage: result.usage,
      querySource: "compact",
      toolCallCount: 0,
    },
    trace,
  );
  await runtime.appendEvent(event, trace);
  events.push(event);
}
