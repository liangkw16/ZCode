// ============================================================
// Skill Tool - load reusable local instructions on demand
// ============================================================

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

const SkillCurrentInputSchema = z.object({
  // 目录可能按预算省略条目；字段说明不能反向限制显式名字，也不能承诺 handler 未实现的参数透传。
  skill: z
    .string()
    .describe(
      "Exact skill name from the catalog, a discovery result, or an explicit user invocation. Do not guess names.",
    ),
  args: z
    .string()
    .optional()
    .describe(
      "Compatibility field; the handler ignores it and does not pass it into skill content.",
    ),
});

const LegacySkillInputSchema = z.object({
  name: z.string().min(1),
  args: z.string().optional(),
});

export const SkillInputSchema = z
  .union([SkillCurrentInputSchema, LegacySkillInputSchema])
  .transform((input) => ({
    args: input.args,
    skill: "skill" in input ? input.skill : input.name,
  }));

export type SkillInput = z.infer<typeof SkillCurrentInputSchema>;
export type SkillRuntimeInput = z.infer<typeof SkillInputSchema>;

export const SkillInputJsonSchema = toToolJsonSchema(SkillCurrentInputSchema);

export interface SkillStructuredOutput {
  name: string;
  content: string;
  baseDirectory: string;
  truncated: boolean;
}

export type SkillOutput = string | SkillStructuredOutput;

export const SkillStructuredOutputSchema = z
  .object({
    name: z.string(),
    content: z.string(),
    baseDirectory: z.string(),
    truncated: z.boolean(),
  })
  .strict();

export const SkillOutputSchema = z.union([z.string(), SkillStructuredOutputSchema]);

export const SkillOutputJsonSchema = toToolJsonSchema(SkillOutputSchema);

export interface SkillToolCall {
  id: ToolCallId;
  name: "Skill";
  input: SkillInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface SkillToolResult {
  toolCallId: ToolCallId;
  output: SkillOutput;
  traceId: TraceId;
  durationMs: number;
}
