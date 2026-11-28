// ============================================================
// Plan Mode Tool Provider Prompts
// ============================================================

export function createEnterPlanModeProviderDescription(
  options: {
    embeddedSearchEnabled?: boolean;
  } = {},
): string {
  const explorationTools = options.embeddedSearchEnabled
    ? "`find`/Glob, `grep`/Grep, and Read"
    : "Glob, Grep, and Read";

  // 修复原因：复杂度和文件数曾自动触发规划审批，且文案误称进入模式需要审批。
  return `Enter read-only plan mode when the user explicitly asks for a read-only discussion or to review an approach before implementation, or when a consequential approach decision needs user input and cannot be resolved from the request, code, or reasonable defaults.

Do not enter merely because the task is complex, spans multiple files, adds a feature, or requires investigating a bug. For a clearly authorized implementation, explore, implement, and verify directly. Do not ask for approval again for an already approved approach.

A request to write a spec or design document authorizes that document work; it does not by itself call for entering a mode that prevents file writes. Stay within the requested document scope. If plan mode is already active, present the document content and explain that the user or host must change modes before it can be written; do not bypass the read-only boundary.

Entering plan mode does not require a separate approval prompt. Submitting an implementation plan through ExitPlanMode does require user approval, including after entering from yolo mode.

In plan mode, explore the codebase with available read-only tools, such as ${explorationTools} when offered, and reuse existing patterns. Keep the depth of the plan proportional to the task. Clarify only a necessary decision that the user must supply: use AskUserQuestion when available, otherwise ask directly. When ready for implementation approval, submit the complete plan through ExitPlanMode if available; if unavailable, show the plan and explain that plan mode remains active.

Pure research can be completed by investigating and answering directly. It does not require delegating to an Agent or requesting implementation approval.`;
}

export const ENTER_PLAN_MODE_PROVIDER_DESCRIPTION = createEnterPlanModeProviderDescription();

export const EXIT_PLAN_MODE_MODEL_INSTRUCTIONS = [
  `Use this tool only while plan mode is active and an implementation plan is ready for user approval.

Pass the complete, actionable plan in the required plan parameter. The user reviews that content; do not assume a plan file exists or send empty input. Include the goal, key changes, recommended approach, and how the result will be verified.

ExitPlanMode requests user approval even when the previous mode was yolo. Approval exits plan mode and restores the previous mode; rejection leaves plan mode active. After approval, implement and verify the plan, updating the todo list if useful.

If a necessary decision can only come from the user, clarify it first with AskUserQuestion when available, otherwise ask directly. Resolve routine choices from the request, code, and reasonable defaults. Do NOT use AskUserQuestion or a separate text question to ask whether the plan is approved or whether to proceed; this tool handles that approval.

For research-only tasks, return the findings directly without calling this tool.

Examples:
- Understand how vim mode is implemented: investigate and answer; no implementation approval is needed.
- Already in plan mode to design yank mode: finish the plan, then submit its complete text through this tool.
- An authentication plan has a consequential unresolved choice that the context cannot settle: clarify that choice, then submit the plan. An ordinary implementation request alone is not a reason to enter plan mode.`,
] as const;
