// ============================================================
// Skills Section Builder
// ============================================================

import type { SkillLoadOutcome, SkillMetadata } from "@zcode/contracts";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

const DEFAULT_SKILL_METADATA_BUDGET = 20_000;
const MAX_DESCRIPTION_CHARS = 250;
const SHORT_DESCRIPTION_CHARS = 80;
const DESCRIPTION_ELLIPSIS = "...";
const MISSING_SKILL_PURPOSE = "Purpose not provided; load only on explicit request.";
const SKILLS_HEADER = "The following skills are available for use with the Skill tool:";

interface SkillsSectionOptions {
  outcome: SkillLoadOutcome;
  metadataBudget?: number;
}

export function buildSkillsSection(options: SkillsSectionOptions): ContextSection | null {
  if (options.outcome.skills.length === 0) {
    return null;
  }

  const content = buildSkillsContent(
    options.outcome.skills,
    options.metadataBudget ?? DEFAULT_SKILL_METADATA_BUDGET,
  );
  if (content === null) return null;

  return {
    name: "Skills",
    source: "skills",
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

function buildSkillsContent(skills: SkillMetadata[], metadataBudget: number): string | null {
  const budget = Math.floor(metadataBudget);
  if (budget < 1) return null;

  const sortedSkills = [...skills].sort((left, right) => {
    const leftName = skillDisplayName(left);
    const rightName = skillDisplayName(right);
    return (
      leftName.localeCompare(rightName, "en-US") ||
      compareCodeUnits(leftName, rightName) ||
      compareCodeUnits(skillPurpose(left), skillPurpose(right))
    );
  });
  const full = renderSkillLines(
    sortedSkills.map((skill) => formatSkillLine(skill, MAX_DESCRIPTION_CHARS)),
  );
  if (full.length <= budget) return full;

  // 旧降级删除所有用途且仍可超限；先均匀缩短用途，再连同提示一起计算总预算。
  const shortLines = sortedSkills.map((skill) => formatSkillLine(skill, SHORT_DESCRIPTION_CHARS));
  const short = renderSkillLines(shortLines);
  if (short.length <= budget) return short;

  const total = sortedSkills.length;
  const emptyNotice = omissionNotice(0, total);
  if (emptyNotice.length > budget) {
    const minimalNotice = `Skills omitted: ${total}.`;
    return minimalNotice.length <= budget ? minimalNotice : null;
  }

  let included = 0;
  let prefixLength = SKILLS_HEADER.length + "\n\n".length;
  for (const line of shortLines) {
    prefixLength += line.length + (included === 0 ? 0 : "\n".length);
    const nextCount = included + 1;
    const candidateLength = prefixLength + "\n\n".length + omissionNotice(nextCount, total).length;
    if (candidateLength > budget) break;
    included = nextCount;
  }
  return included === 0
    ? emptyNotice
    : `${renderSkillLines(shortLines.slice(0, included))}\n\n${omissionNotice(included, total)}`;
}

function renderSkillLines(lines: string[]): string {
  return `${SKILLS_HEADER}\n\n${lines.join("\n")}`;
}

function omissionNotice(included: number, total: number): string {
  return (
    `Showing ${included} of ${total} skills; the catalog is incomplete. ` +
    "A user's explicit exact name can still be loaded with Skill; do not guess names. " +
    "Use zcode skills list --json in the same working directory if command execution is available and zcode is installed and runnable. " +
    "CLI discovery may use different configuration; this session's Skill result determines availability."
  );
}

function formatSkillLine(skill: SkillMetadata, maxDescriptionChars: number): string {
  const description = skillPurpose(skill);
  let trimmed = description;
  if (description.length > maxDescriptionChars) {
    const end = maxDescriptionChars - DESCRIPTION_ELLIPSIS.length;
    // 字符预算使用 UTF-16 length，但不能把截断点上的代理对拆成无效 Unicode。
    trimmed = `${description.slice(0, end).replace(/[\uD800-\uDBFF]$/u, "")}${DESCRIPTION_ELLIPSIS}`;
  }
  return `- ${skillDisplayName(skill)}: ${trimmed}`;
}

function skillPurpose(skill: SkillMetadata): string {
  const purpose = [skill.description, skill.whenToUse]
    .map((part) => part?.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join(" - ");
  // 无 frontmatter 的兼容技能允许空描述；明确缺失，不凭名字猜用途或触发自动加载。
  return purpose || MISSING_SKILL_PURPOSE;
}

function skillDisplayName(skill: SkillMetadata): string {
  return skill.qualifiedName ?? skill.name;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
