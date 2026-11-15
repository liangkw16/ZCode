import { describe, expect, it } from "vitest";
import { createSessionId, createTraceId, DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";
import type { SkillContent, SkillLoadOutcome, SkillLoadRequest, SkillPort } from "@zcode/contracts";
import { createContextBuilder } from "../src/context/index.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import {
  SKILL_RESULT_WRAPPER_BYTES,
  skillHandler,
  skillToolEntry,
  WORKFLOW_SKILL_MAX_BYTES,
} from "../src/tool/handlers/skill.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

const skillOutcome: SkillLoadOutcome = {
  skills: [
    {
      name: "demo-skill",
      description: "Use this for demo workflows",
      path: "/workspace/.zcode/skills/demo-skill/SKILL.md",
      directory: "/workspace/.zcode/skills/demo-skill",
      rootPath: "/workspace/.zcode/skills",
      scope: "project",
      source: "zcode",
      safeToAutoLoad: true,
      frontmatterKeys: ["name", "description"],
      policy: { allowImplicitInvocation: true },
    },
  ],
  diagnostics: [],
  totalDiscovered: 1,
};

describe("Skill integration", () => {
  it("preserves explicit invocation while limiting automatic loading and visible-body reuse", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, { includeSkill: true });
    const description = registry.toContracts().find((tool) => tool.name === "Skill")!.description;
    expect(description).toContain("clearly matches");
    expect(description).toContain("materially help");
    expect(description).toContain("user's explicit invocation");
    expect(description).toContain("same skill and source");
    expect(description).toContain("body is still visible");
    expect(description).toContain("summary");
    expect(description).toContain("does not consume");
    expect(description).not.toContain("optional arguments to pass through");
    expect(description).not.toContain("the skill is loaded — follow it directly");
  });

  it("loads an explicit name through SkillPort even when omitted from the directory, ignoring args", async () => {
    const requested: SkillLoadRequest[] = [];
    const loaded = await skillHandler(
      { skill: "omitted-skill", args: "do not interpolate this" },
      contextWithSkillPort({
        async discoverSkills() {
          return { skills: [], diagnostics: [], totalDiscovered: 0 };
        },
        async loadSkill(request) {
          requested.push(request);
          return {
            metadata: { ...skillOutcome.skills[0]!, name: request.name },
            content: "Task arguments: $ARGUMENTS",
            baseDirectory: "/workspace/.zcode/skills/omitted-skill",
            bytesRead: 26,
            sizeBytes: 26,
            truncated: false,
          };
        },
      }),
    );
    expect(requested[0]?.name).toBe("omitted-skill");
    expect(requested[0]).not.toHaveProperty("args");
    expect(loaded).toContain("$ARGUMENTS");
    expect(loaded).not.toContain("do not interpolate this");
  });

  it("renders available skills in context without loading body", () => {
    const builder = createContextBuilder({
      workingDirectory: "/workspace",
      envInfo: {
        cwd: "/workspace",
        platform: "test",
        shell: "test",
        osVersion: "test",
        nodeVersion: "test",
      },
      skills: skillOutcome,
    });

    const result = builder.build();
    const system =
      result.systemMessages.find((message) => message.role === "system")?.content ?? "";
    const skillReminder =
      result.metaUserAttachments.find((attachment) => attachment.source === "skills_listing")
        ?.content ?? "";

    expect(system).not.toContain("demo-skill");
    expect(skillReminder).toContain("The following skills are available");
    expect(skillReminder).toContain("demo-skill");
  });

  it("loads skill content through SkillPort using the legacy name field", async () => {
    const loaded = await skillHandler(
      { name: "demo-skill" },
      contextWithSkillPort({
        async discoverSkills(): Promise<SkillLoadOutcome> {
          return skillOutcome;
        },
        async loadSkill(): Promise<SkillContent> {
          return {
            metadata: skillOutcome.skills[0]!,
            content: "# Demo Skill\n\nFollow this workflow.",
            baseDirectory: "/workspace/.zcode/skills/demo-skill",
            bytesRead: 37,
            sizeBytes: 37,
            truncated: false,
          };
        },
      }),
    );

    expect(loaded).toContain('<skill_content name="demo-skill">');
    expect(loaded).toContain("Follow this workflow.");
    expect(loaded).toContain("Base directory for this skill");
  });

  it("loads skill content through SkillPort using the provider-visible skill field", async () => {
    const loaded = await skillHandler(
      { skill: "demo-skill" },
      contextWithSkillPort({
        async discoverSkills(): Promise<SkillLoadOutcome> {
          return skillOutcome;
        },
        async loadSkill(): Promise<SkillContent> {
          return {
            metadata: skillOutcome.skills[0]!,
            content:
              "# Demo Skill\n\nRead ${CLAUDE_SKILL_DIR}/references.md and ${ZCODE_SKILL_DIR}/notes.md.",
            baseDirectory: "/workspace/.zcode/skills/demo-skill",
            bytesRead: 91,
            sizeBytes: 91,
            truncated: false,
          };
        },
      }),
    );

    expect(loaded).toContain('<skill_content name="demo-skill">');
    expect(loaded).toContain("/workspace/.zcode/skills/demo-skill/references.md");
    expect(loaded).toContain("/workspace/.zcode/skills/demo-skill/notes.md");
  });

  it("reports resolved skill metadata through the telemetry callback without changing content", async () => {
    const metadata = {
      ...skillOutcome.skills[0]!,
      name: "pptx",
      pluginName: "document-skills",
      pluginId: "document-skills@zcode-plugins-official",
      qualifiedName: "document-skills:pptx",
      source: "plugin" as const,
    };
    const reported: unknown[] = [];
    const loaded = await skillHandler(
      { skill: "document-skills:pptx" },
      contextWithSkillPort(
        {
          async discoverSkills(): Promise<SkillLoadOutcome> {
            return { ...skillOutcome, skills: [metadata] };
          },
          async loadSkill(): Promise<SkillContent> {
            return {
              metadata,
              content: "# PPTX Skill\n\nDescription stays in the skill body.",
              baseDirectory: "/plugins/document-skills/skills/pptx",
              bytesRead: 50,
              sizeBytes: 50,
              truncated: false,
            };
          },
        },
        (value) => reported.push(value),
      ),
    );

    expect(reported).toEqual([
      {
        name: "pptx",
        qualifiedName: "document-skills:pptx",
        pluginId: "document-skills@zcode-plugins-official",
        source: "plugin",
      },
    ]);
    expect(loaded).toContain("Description stays in the skill body.");
  });

  // docs/dynamic-workflow/authoring.md「The skill」：只有工作流技能拿 200 000 字节的上限，其余技能仍是 100 000。
  // 判据是请求里的名字，与技能门认的同一个。
  it("loads dynamic-workflows with its own byte cap and every other skill with the default", async () => {
    const requested: SkillLoadRequest[] = [];
    const port: SkillPort = {
      async discoverSkills(): Promise<SkillLoadOutcome> {
        return skillOutcome;
      },
      async loadSkill(request): Promise<SkillContent> {
        requested.push(request);
        return {
          metadata: { ...skillOutcome.skills[0]!, name: request.name },
          content: "body",
          baseDirectory: "/workspace/.zcode/skills/demo-skill",
          bytesRead: 4,
          sizeBytes: 4,
          truncated: false,
        };
      },
    };

    await skillHandler({ skill: DYNAMIC_WORKFLOW_SKILL_NAME }, contextWithSkillPort(port));
    await skillHandler({ skill: "demo-skill" }, contextWithSkillPort(port));

    expect(requested.map((request) => request.maxBytes)).toEqual([200_000, 100_000]);
  });

  // 结果预算是工具级的静态值：必须装得下最大上限的正文再加外壳，否则贴着上限的技能会被从尾部再截一刀。
  it("gives the tool result room for the largest skill plus its wrapper", () => {
    const ceiling = WORKFLOW_SKILL_MAX_BYTES + SKILL_RESULT_WRAPPER_BYTES;
    expect(skillToolEntry.metadata.maxOutputBytes).toBeGreaterThanOrEqual(ceiling);
    expect(skillToolEntry.resultBudget.maxInlineBytes).toBeGreaterThanOrEqual(ceiling);
    expect(skillToolEntry.resultBudget.maxModelBytes).toBeGreaterThanOrEqual(ceiling);
  });

  it("上报 remote 来源的实际 skill name", async () => {
    const reported: unknown[] = [];
    const metadata = { ...skillOutcome.skills[0]!, source: "remote" as const };
    await skillHandler(
      { skill: "requested-alias" },
      contextWithSkillPort(
        {
          async discoverSkills() {
            return skillOutcome;
          },
          async loadSkill() {
            return {
              metadata,
              content: "body",
              baseDirectory: "/skills",
              bytesRead: 4,
              sizeBytes: 4,
              truncated: false,
            };
          },
        },
        (value) => reported.push(value),
      ),
    );
    expect(reported).toEqual([{ name: "demo-skill", source: "remote" }]);
  });

  it("can omit the Skill tool when the runtime has no SkillPort", () => {
    const registry = createToolRegistry();

    registerBuiltInTools(registry, { includeSkill: false });

    expect(registry.has("Read")).toBe(true);
    expect(registry.has("Skill")).toBe(false);
  });
});

function contextWithSkillPort(
  skillPort: SkillPort,
  recordSkillTelemetryMetadata?: ToolExecutionContext["recordSkillTelemetryMetadata"],
): ToolExecutionContext {
  return {
    toolCallId: "tool-skill",
    traceId: createTraceId(),
    abortSignal: new AbortController().signal,
    skillPort,
    ...(recordSkillTelemetryMetadata ? { recordSkillTelemetryMetadata } : {}),
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
    sessionId: createSessionId("skill-test"),
  };
}
