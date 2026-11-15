import type { SkillMetadata } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { buildSkillsSection } from "../src/context/sections/skills.js";

function skill(name: string, description = "Inspect deployment failures"): SkillMetadata {
  return {
    name,
    description,
    path: `/very/long/workspace/path/${name}/SKILL.md`,
    directory: `/very/long/workspace/path/${name}`,
    rootPath: "/very/long/workspace/path",
    scope: "project",
    source: "zcode",
    safeToAutoLoad: true,
    frontmatterKeys: ["name", "description"],
  };
}

function render(skills: SkillMetadata[], metadataBudget?: number) {
  return buildSkillsSection({
    outcome: { skills, diagnostics: [], totalDiscovered: skills.length },
    ...(metadataBudget === undefined ? {} : { metadataBudget }),
  });
}

function entries(content: string) {
  return content.split("\n").filter((line) => line.startsWith("- "));
}

describe("Skill directory budget", () => {
  it("keeps exact qualified names and normalized purposes without repeated paths or aliases", () => {
    const entry = {
      ...skill("review", "Review\n changes"),
      qualifiedName: "tools:review",
      whenToUse: "Before\t delivery",
    };
    const section = render([entry])!;
    expect(entries(section.content)).toEqual(["- tools:review: Review changes - Before delivery"]);
    expect(section.content).not.toContain(entry.path);
    expect(section.content).not.toContain("also loadable as");
    expect(section.chars).toBe(section.content.length);
    expect(section.injectionTarget).toBe("meta_user");
  });

  it("counts all text at the exact boundary and compresses every purpose before omitting", () => {
    const skills = ["alpha", "beta", "gamma"].map((name) => skill(name, "Purpose ".repeat(60)));
    const full = render(skills)!;
    expect(entries(full.content).every((line) => line.split(": ")[1]!.length === 250)).toBe(true);
    expect(render(skills, full.content.length)?.content).toBe(full.content);

    const compressed = render(skills, full.content.length - 1)!;
    expect(entries(compressed.content)).toHaveLength(3);
    expect(entries(compressed.content).every((line) => line.split(": ")[1]!.length === 80)).toBe(
      true,
    );
    expect(compressed.chars).toBeLessThanOrEqual(full.content.length - 1);
  });

  it("retains a sorted prefix with purposes and a truthful discovery notice under a hard budget", () => {
    const skills = Array.from({ length: 30 }, (_, index) =>
      skill(`skill-${String(index).padStart(2, "0")}`, "Purpose ".repeat(50)),
    );
    const content = render([...skills].reverse(), 1_000)!.content;
    const retained = entries(content);
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(skills.length);
    expect(retained.map((line) => line.split(": ")[0])).toEqual(
      skills.slice(0, retained.length).map((entry) => `- ${entry.name}`),
    );
    expect(retained.every((line) => line.split(": ")[1]!.length === 80)).toBe(true);
    expect(content).toContain(`Showing ${retained.length} of 30 skills`);
    expect(content).toContain("zcode skills list --json");
    expect(content).toContain(
      "if command execution is available and zcode is installed and runnable",
    );
    expect(content).toContain("explicit exact name");
    expect(content.length).toBeLessThanOrEqual(1_000);
    expect(content.length + retained[0]!.length + 1).toBeGreaterThan(1_000);
    expect(render(skills, 1_000)?.content).toBe(content);
    expect(skills).toHaveLength(30);
  });

  it("never skips an oversized first entry to silently promote a later skill", () => {
    const section = render([skill("a".repeat(2_000)), skill("z")], 800)!;
    expect(entries(section.content)).toEqual([]);
    expect(section.content).toContain("Showing 0 of 2 skills");
    expect(section.content.length).toBeLessThanOrEqual(800);
  });

  it("uses the minimal notice or no section when the budget cannot fit a useful catalog", () => {
    const skills = [skill("demo")];
    const notice = "Skills omitted: 1.";
    expect(render(skills, notice.length + 0.9)?.content).toBe(notice);
    expect(render(skills, notice.length - 1)).toBeNull();
    expect(render(skills, 0)).toBeNull();
    expect(render(skills, 0.9)).toBeNull();
    expect(render([])).toBeNull();
  });

  it("does not split surrogate pairs in either description limit", () => {
    const skills = [skill("emoji", `${"a".repeat(246)}😀${"b".repeat(100)}`)];
    const full = render(skills)!;
    expect(full.content.isWellFormed()).toBe(true);
    expect(entries(full.content)[0]!.split(": ")[1]!.length).toBeLessThanOrEqual(250);
    const short = render(
      [skill("emoji", `${"a".repeat(76)}😀${"b".repeat(300)}`)],
      full.content.length - 1,
    )!;
    expect(short.content.isWellFormed()).toBe(true);
    expect(entries(short.content)[0]!.split(": ")[1]!.length).toBeLessThanOrEqual(80);
  });

  it("uses code-unit order to break locale-equal names independently of input order", () => {
    const skills = [skill("é"), skill("e\u0301")];
    const content = render(skills)!.content;
    expect(entries(content).map((line) => line.split(": ")[0])).toEqual(["- e\u0301", "- é"]);
    expect(render([...skills].reverse())?.content).toBe(content);
  });

  it("marks missing compatibility descriptions without inventing a purpose", () => {
    const content = render([
      skill("unknown", " \n\t "),
      { ...skill("when-only", ""), whenToUse: "When checking releases" },
    ])!.content;
    expect(entries(content)).toEqual([
      "- unknown: Purpose not provided; load only on explicit request.",
      "- when-only: When checking releases",
    ]);
  });

  it("enforces the default 20,000-character budget without deleting all purposes", () => {
    const skills = Array.from({ length: 500 }, (_, index) =>
      skill(`skill-${index}`, "Useful ".repeat(60)),
    );
    const content = render(skills)!.content;
    expect(content.length).toBeLessThanOrEqual(20_000);
    expect(entries(content).length).toBeGreaterThan(0);
    expect(entries(content).every((line) => line.includes(": Useful"))).toBe(true);
  });
});
