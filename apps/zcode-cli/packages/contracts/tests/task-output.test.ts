import { describe, expect, it } from "vitest";
import {
  TASK_OUTPUT_PROVIDER_DESCRIPTION,
  TaskOutputInputJsonSchema,
  TaskOutputInputSchema,
} from "../src/tools/task-output.js";

describe("TaskOutput contracts", () => {
  it("exposes the canonical provider description", () => {
    expect(TASK_OUTPUT_PROVIDER_DESCRIPTION).not.toContain("DEPRECATED");
    expect(TASK_OUTPUT_PROVIDER_DESCRIPTION).not.toContain("remote sessions");
    expect(TASK_OUTPUT_PROVIDER_DESCRIPTION).toContain("task registered in the current runtime");
    expect(TASK_OUTPUT_PROVIDER_DESCRIPTION).toContain("use block=true for a bounded wait");
    expect(TASK_OUTPUT_PROVIDER_DESCRIPTION).toContain(
      "use block=false for a current status check",
    );
    expect(TASK_OUTPUT_PROVIDER_DESCRIPTION).toContain("not that the task succeeded");
    expect(TASK_OUTPUT_PROVIDER_DESCRIPTION).toContain("cancelling a wait does not stop the task");
  });

  it("exposes the canonical provider input schema", () => {
    expect(TaskOutputInputJsonSchema).toEqual({
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The task ID to get output from",
        },
        block: {
          type: "boolean",
          default: true,
          description: "Whether to wait for completion",
        },
        timeout: {
          type: "number",
          default: 30_000,
          minimum: 0,
          maximum: 600_000,
          description: "Max wait time in ms",
        },
      },
      required: ["task_id", "block", "timeout"],
      additionalProperties: false,
      $schema: "https://json-schema.org/draft/2020-12/schema",
    });
  });

  it("applies defaults and accepts only the supported semantic boolean strings", () => {
    expect(TaskOutputInputSchema.parse({ task_id: "agent_1" })).toEqual({
      task_id: "agent_1",
      block: true,
      timeout: 30_000,
    });
    expect(
      TaskOutputInputSchema.parse({
        task_id: "agent_1",
        block: "false",
        timeout: 0,
      }),
    ).toEqual({
      task_id: "agent_1",
      block: false,
      timeout: 0,
    });
    expect(TaskOutputInputSchema.parse({ task_id: "agent_1", block: "true" }).block).toBe(true);
    expect(
      TaskOutputInputSchema.safeParse({
        task_id: "agent_1",
        block: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields and out-of-range timeout values", () => {
    expect(
      TaskOutputInputSchema.safeParse({
        task_id: "agent_1",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      TaskOutputInputSchema.safeParse({
        task_id: "agent_1",
        timeout: 600_001,
      }).success,
    ).toBe(false);
  });
});
