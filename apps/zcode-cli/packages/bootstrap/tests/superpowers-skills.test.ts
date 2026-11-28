import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import type { SkillRoot } from "@zcode/contracts";
import { describe, expect, it } from "vitest";

const pluginRoot = fileURLToPath(new URL("../../superpowers-plugin/", import.meta.url));
const roots: SkillRoot[] = [
  {
    path: join(pluginRoot, "skills"),
    source: "plugin",
    scope: "system",
    priority: 0,
  },
];

async function load(name: string): Promise<string> {
  // 读取本仓库实际插件包，显式 roots 避免用户同名技能让文本回归产生假通过。
  const result = await createNodeSkillAdapter().loadSkill({
    name: `superpowers:${name}`,
    workingDirectory: pluginRoot,
    roots,
  });
  expect(result.metadata.qualifiedName).toBe(`superpowers:${name}`);
  return result.content;
}

describe("Superpowers plugin execution contracts", () => {
  it("loads the actual entry skill and keeps SessionStart pointed at that same body", async () => {
    const [body, hook, hooks] = await Promise.all([
      load("using-superpowers"),
      readFile(join(pluginRoot, "hooks", "session-start"), "utf8"),
      readFile(join(pluginRoot, "hooks", "hooks.json"), "utf8"),
    ]);
    expect(body).toContain("clearly matches");
    expect(body).toContain("materially help");
    expect(body).toContain("same skill and source");
    expect(body).toContain("do not override system instructions");
    expect(body).not.toContain("1%");
    expect(body).not.toContain("BEFORE any response");
    expect(hook).toContain("${PLUGIN_ROOT}/skills/using-superpowers/SKILL.md");
    expect(hook).toContain("${using_superpowers_escaped}");
    expect(hooks).toContain("SessionStart");
    expect(hooks).toContain("session-start");
  });

  it("keeps brainstorming conditional and preserves existing approval and phase boundaries", async () => {
    const body = await load("brainstorming");
    expect(body).toContain("already authorized");
    expect(body).toContain("spec-only");
    expect(body).toContain("does not require another approval");
    expect(body).not.toContain("<HARD-GATE>");
    expect(body).not.toContain("EVERY project");
    expect(body).not.toContain("Commit the design document");
  });

  it("hands an authorized plan to execution without a mandatory method selection", async () => {
    const body = await load("writing-plans");
    expect(body).toContain("implementation is already authorized");
    expect(body).toContain("independent work");
    expect(body).toContain("asked to review the plan first");
    expect(body).not.toContain("Which approach?");
    expect(body).not.toContain("REQUIRED SUB-SKILL");
  });

  it("diagnoses ordinary execution failures before requesting necessary decisions", async () => {
    const body = await load("executing-plans");
    expect(body).toContain("missing dependency");
    expect(body).toContain("diagnose");
    expect(body).toContain("independent work");
    expect(body).not.toContain("STOP executing immediately");
    expect(body).not.toContain("If subagents are available, use");
  });

  it("ties verification to changed conditions and honest scope, not the current message", async () => {
    const body = await load("verification-before-completion");
    for (const condition of ["version", "environment", "inputs", "acceptance"]) {
      expect(body).toContain(condition);
    }
    expect(body).toContain("Reuse valid evidence");
    expect(body).toContain("API success does not prove UI success");
    expect(body).not.toContain("in this message");
    expect(body).not.toContain("Execute the FULL command");
  });
});
