import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TASK_OUTPUT_TOOL_NAME = "TaskOutput";
export const TASK_OUTPUT_ALIASES = [
  "AgentOutputTool",
  "BashOutputTool",
  "AgentOutput",
  "BashOutput",
] as const;

export const TASK_OUTPUT_PROVIDER_DESCRIPTION = `Query the status and output of a task registered in the current runtime, or wait for its completion.
- Use the exact task_id returned by the task launch, a task notification, or an available task query. Never construct a task ID from a callId, tool-use-id, output path, or naming pattern.
- Prefer completion notifications and already delivered Agent results. Continue independent work while a task runs. When its result is needed, use block=true for a bounded wait; use block=false for a current status check. Do not use sleep, no-op calls, or tight polling to provoke notifications.
- Read retrieves logs; it does not wait for task completion or establish task status. Read only an output path explicitly returned and allowed for reading. An empty or unchanged file does not prove task failure or completion; do not read a full child conversation just to check status.
- retrieval_status=success means the terminal result was retrieved, not that the task succeeded. Inspect task status, exit_code, and error. not_ready means the task is active; timeout means this wait did not obtain a terminal result. Neither means the task failed or stopped, and cancelling a wait does not stop the task.
- If a task is not found, verify the original ID and current runtime. Increasing timeout cannot repair a wrong ID. A runtime restart may make an old handle unavailable; check existing notifications, returned output, and prior effects before deciding whether a retry is safe. Do not blindly rerun a task whose outcome is unknown.`;

export const TaskOutputInputSchema = z
  .object({
    task_id: z.string().describe("The task ID to get output from"),
    block: semanticBoolean(z.boolean().default(true)).describe("Whether to wait for completion"),
    timeout: z.number().min(0).max(600_000).default(30_000).describe("Max wait time in ms"),
  })
  .strict();

export type TaskOutputInput = z.infer<typeof TaskOutputInputSchema>;

export const TaskOutputInputJsonSchema = {
  ...toToolJsonSchema(TaskOutputInputSchema),

  // 的 provider schema 仍要求模型显式传入 task_id、block 和 timeout。
  required: ["task_id", "block", "timeout"],
};

export const TaskOutputTaskSchema = z
  .object({
    task_id: z.string(),
    task_type: z.string(),
    status: z.string(),
    description: z.string(),
    output: z.string(),
    exitCode: z.number().nullable().optional(),
    error: z.string().optional(),
    prompt: z.string().optional(),
    result: z.string().optional(),
    outputFile: z.string().optional(),
    /** 运行中的后台 Agent 的当前进展（与无进展提醒同一份事实）。 */
    activity: z
      .object({
        last_progress_at: z.string(),
        no_progress_for_ms: z.number(),
        running_tools: z.array(
          z
            .object({
              tool_name: z.string(),
              running_for_ms: z.number(),
              summary: z.string().optional(),
            })
            .strict(),
        ),
        waiting_for_permission: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type TaskOutputTask = z.infer<typeof TaskOutputTaskSchema>;

export const TaskOutputResultSchema = z
  .object({
    retrieval_status: z.enum(["success", "not_ready", "timeout"]),
    task: TaskOutputTaskSchema.nullable(),
  })
  .strict();

export type TaskOutputResult = z.infer<typeof TaskOutputResultSchema>;

export const TaskOutputResultJsonSchema = toToolJsonSchema(TaskOutputResultSchema);

function semanticBoolean(
  schema: z.ZodDefault<z.ZodBoolean>,
): z.ZodEffects<z.ZodDefault<z.ZodBoolean>, boolean, unknown> {
  return z.preprocess((value) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }, schema);
}
