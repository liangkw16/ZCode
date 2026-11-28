// ============================================================
// Plan Mode Tool Handlers
// ============================================================

import {
  CoreErrorType,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  EnterPlanModeInputJsonSchema,
  EnterPlanModeInputSchema,
  EnterPlanModeOutputJsonSchema,
  EnterPlanModeOutputSchema,
  ExitPlanModeInputJsonSchema,
  ExitPlanModeInputSchema,
  ExitPlanModeOutputJsonSchema,
  ExitPlanModeOutputSchema,
  createCoreError,
  isFileSystemPortError,
  type EnterPlanModeOutput,
  type ExitPlanModeInput,
  type ExitPlanModeOutput,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../types.js";
import { writeApprovedPlanFile } from "../../runtime/helpers/plan-file-continuity.js";
import {
  ENTER_PLAN_MODE_PROVIDER_DESCRIPTION,
  createEnterPlanModeProviderDescription,
  EXIT_PLAN_MODE_MODEL_INSTRUCTIONS,
} from "./plan-mode-prompts.js";

const MAX_PLAN_MODE_MODEL_BYTES = 100_000;

const EXIT_PLAN_MODE_DESCRIPTION = EXIT_PLAN_MODE_MODEL_INSTRUCTIONS[0];

export const enterPlanModeHandler: ToolHandler = async (input, context) => {
  EnterPlanModeInputSchema.parse(input);
  assertSessionModePort(context, ENTER_PLAN_MODE_TOOL_NAME);

  const transition = await context.sessionModePort.enterPlanMode({
    toolCallId: context.toolCallId,
    traceContext: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      turnId: context.turnId,
    },
  });

  return {
    message:
      "Entered plan mode. Read-only exploration is now active; entering did not require a separate approval prompt.",
    mode: transition.mode,
    previousMode: transition.previousMode,
    planEnabled: transition.planEnabled,
    previousPlanEnabled: transition.previousPlanEnabled,
  } satisfies EnterPlanModeOutput;
};

export const exitPlanModeHandler: ToolHandler = async (input, context) => {
  const parsed = ExitPlanModeInputSchema.parse(input) as ExitPlanModeInput;
  assertSessionModePort(context, EXIT_PLAN_MODE_TOOL_NAME);

  if (
    !(context.sessionModePort.isPlanEnabled?.() ?? context.sessionModePort.getMode() === "plan")
  ) {
    throw createCoreError(
      CoreErrorType.InvalidStateTransition,
      "You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: EXIT_PLAN_MODE_TOOL_NAME,
        },
        recoverable: true,
      },
    );
  }

  await persistApprovedPlanFileBeforeExitPlanMode({
    context,
    plan: parsed.plan,
  });

  const transition = await context.sessionModePort.exitPlanMode({
    toolCallId: context.toolCallId,
    traceContext: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      turnId: context.turnId,
    },
  });

  return {
    allowedPrompts: parsed.allowedPrompts,
    approved: true,
    planEnabled: transition.planEnabled,
    previousPlanEnabled: transition.previousPlanEnabled,
    mode: transition.mode,
    plan: parsed.plan,
    previousMode: transition.previousMode,
  } satisfies ExitPlanModeOutput;
};

export const enterPlanModeToolEntry: ToolEntry = {
  capability: "Enter read-only planning mode before implementation",
  requiresUserInteraction: false,
  metadata: {
    shouldDefer: true,
    name: ENTER_PLAN_MODE_TOOL_NAME,
    searchHint: "switch to plan mode to design an approach before coding",
    description: ENTER_PLAN_MODE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    requiresUserInteraction: false,
    timeoutMs: 30000,
    maxOutputBytes: MAX_PLAN_MODE_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: enterPlanModeHandler,
  formatModelContent: formatEnterPlanModeModelContent,
  inputSchema: EnterPlanModeInputJsonSchema,
  outputSchema: EnterPlanModeOutputJsonSchema,
  runtimeInputSchema: EnterPlanModeInputSchema,
  runtimeOutputSchema: EnterPlanModeOutputSchema,
  permission: planModePermission("plan.enter", "EnterPlanMode changes session mode to plan", false),
  resultBudget: planModeResultBudget(),
  timeout: planModeTimeout(),
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "EnterPlanMode was cancelled before plan mode was entered",
  },
  trace: planModeTracePolicy(),
};

export function createEnterPlanModeToolEntry(
  options: {
    embeddedSearchEnabled?: boolean;
  } = {},
): ToolEntry {
  return {
    ...enterPlanModeToolEntry,
    metadata: {
      ...enterPlanModeToolEntry.metadata,
      description: createEnterPlanModeProviderDescription(options),
    },
  };
}

export const exitPlanModeToolEntry: ToolEntry = {
  capability: "Request user approval for the plan and exit planning mode before coding",
  requiresUserInteraction: true,
  metadata: {
    shouldDefer: true,
    name: EXIT_PLAN_MODE_TOOL_NAME,
    searchHint: "present plan for approval and start coding (plan mode only)",
    description: EXIT_PLAN_MODE_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    requiresUserInteraction: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_PLAN_MODE_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: true,
  },
  handler: exitPlanModeHandler,
  formatModelContent: formatExitPlanModeModelContent,
  inputSchema: ExitPlanModeInputJsonSchema,
  outputSchema: ExitPlanModeOutputJsonSchema,
  runtimeInputSchema: ExitPlanModeInputSchema,
  runtimeOutputSchema: ExitPlanModeOutputSchema,
  permission: planModePermission(
    "plan.exit",
    "ExitPlanMode changes session mode after user plan approval",
  ),
  resultBudget: planModeResultBudget(),
  timeout: planModeTimeout(),
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "ExitPlanMode was cancelled before plan mode was exited",
  },
  trace: planModeTracePolicy(),
};

function assertSessionModePort(
  context: ToolExecutionContext,
  toolName: typeof ENTER_PLAN_MODE_TOOL_NAME | typeof EXIT_PLAN_MODE_TOOL_NAME,
): asserts context is ToolExecutionContext & {
  sessionModePort: NonNullable<ToolExecutionContext["sessionModePort"]>;
} {
  if (context.sessionModePort) return;

  throw createCoreError(
    CoreErrorType.ConfigurationError,
    `SessionModePort is not configured for ${toolName}`,
    {
      context: {
        toolCallId: context.toolCallId,
        toolName,
      },
      recoverable: false,
    },
  );
}

async function persistApprovedPlanFileBeforeExitPlanMode(input: {
  context: ToolExecutionContext;
  plan: string;
}): Promise<void> {
  const { context } = input;
  if (!context.fileSystemPort) return;

  try {
    await writeApprovedPlanFile({
      abortSignal: context.abortSignal,
      fileSystemPort: context.fileSystemPort,
      plan: input.plan,
      sessionId: context.sessionId,
      traceContext: createPlanModeToolTraceContext(context),
      workspaceRoot: context.workspaceRoot,
    });
  } catch (error) {
    if (isPlanFilePersistenceCancellation(error, context.abortSignal)) {
      throw createCoreError(
        CoreErrorType.ToolCancelled,
        "ExitPlanMode was cancelled before plan mode was exited",
        {
          cause: error instanceof Error ? error : undefined,
          context: {
            toolCallId: context.toolCallId,
            toolName: EXIT_PLAN_MODE_TOOL_NAME,
          },
          recoverable: true,
        },
      );
    }
  }
}

function createPlanModeToolTraceContext(context: ToolExecutionContext) {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    turnId: context.turnId,
  };
}

function isPlanFilePersistenceCancellation(error: unknown, abortSignal: AbortSignal): boolean {
  return abortSignal.aborted || (isFileSystemPortError(error) && error.code === "cancelled");
}

function formatEnterPlanModeModelContent(output: unknown): string {
  const result = output as EnterPlanModeOutput;
  return `${result.message}

Use available read-only tools to understand the request and reuse existing code. Keep planning proportional to the task. Clarify only necessary decisions that the user must supply, using AskUserQuestion if available or asking directly otherwise.

For an implementation plan ready for approval, pass its complete text in ExitPlanMode.plan if the tool is available. This requests approval even if the previous mode was yolo. If the tool is unavailable, show the plan and explain that plan mode remains active; a text reply does not switch modes. For pure research, return your findings directly without requesting implementation approval.

Do not write or edit files, including spec or plan files, while plan mode is active. A document-writing request does not override this boundary; present the content and explain that the user or host must change modes before writing it.`;
}

function formatExitPlanModeModelContent(output: unknown): string {
  const result = output as ExitPlanModeOutput;
  const plan = result.plan?.trim();
  if (!plan) {
    return "User has approved exiting plan mode. You can now proceed.";
  }

  return `User has approved your plan. You can now start coding. Start with updating your todo list if applicable.

## Approved Plan:
${plan}`;
}

function planModePermission(
  permission: string,
  reason: string,
  needsApproval = true,
): ToolPermissionSpec {
  return {
    permission,
    reason,
    riskLevel: "low" as const,
    sideEffectScope: "session" as const,
    needsApproval,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk" as const,
  };
}

function planModeResultBudget() {
  return {
    maxInlineBytes: MAX_PLAN_MODE_MODEL_BYTES,
    maxModelBytes: MAX_PLAN_MODE_MODEL_BYTES,
    strategy: "truncate" as const,
    preview: {
      maxBytes: MAX_PLAN_MODE_MODEL_BYTES,
      direction: "head" as const,
    },
  };
}

function planModeTimeout() {
  return {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  };
}

function planModeTracePolicy() {
  return {
    required: true as const,
    propagateToAdapters: false,
    recordInput: "summary" as const,
    recordOutput: "summary" as const,
  };
}
