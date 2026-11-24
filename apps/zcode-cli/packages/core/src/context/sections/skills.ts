// ============================================================
// Skills 列表格式（skills_listing 收集器使用）
// ============================================================

import type { SkillMetadata } from "@zcode/contracts";

export const DEFAULT_SKILL_METADATA_BUDGET = 20_000;
const MAX_DESCRIPTION_CHARS = 250;
// 合并自 kcode：完整格式超预算时先均匀缩短用途，而不是一步删光所有描述。
const SHORT_DESCRIPTION_CHARS = 80;
const DESCRIPTION_ELLIPSIS = "...";
const MISSING_SKILL_PURPOSE = "Purpose not provided; load only on explicit request.";
const SKILLS_LISTING_HEADING = "The following skills are available for use with the Skill tool:";

/** 列表公告正文：完整格式超预算时按 短描述 → 部分行+省略提示 逐级降级。增量公告用同一规则。 */
export function buildSkillsContent(skills: readonly SkillMetadata[], budget: number): string {
  const floorBudget = Math.floor(budget);
  const sortedSkills = sortSkillsForListing(skills);
  const skillLines = sortedSkills.map((skill) => formatSkillLine(skill));
  const full = `${SKILLS_LISTING_HEADING}\n\n${skillLines.join("\n")}`;
  if (full.length <= floorBudget) {
    return full;
  }

  // 旧降级一步删除所有用途且仍可超限；先均匀缩短用途，再连同提示一起计算总预算。
  const shortLines = sortedSkills.map((skill) => formatSkillLine(skill, SHORT_DESCRIPTION_CHARS));
  const short = `${SKILLS_LISTING_HEADING}\n\n${shortLines.join("\n")}`;
  if (short.length <= floorBudget) return short;

  const total = sortedSkills.length;
  const emptyNotice = omissionNotice(0, total);
  if (emptyNotice.length > floorBudget) {
    // 预算连省略提示都放不下时，退到最短可读通知；再截断它只会产出误导性碎片。
    return `Skills omitted: ${total}.`;
  }

  let included = 0;
  let prefixLength = SKILLS_LISTING_HEADING.length + "\n\n".length;
  for (const line of shortLines) {
    prefixLength += line.length + (included === 0 ? 0 : "\n".length);
    const nextCount = included + 1;
    const candidateLength = prefixLength + "\n\n".length + omissionNotice(nextCount, total).length;
    if (candidateLength > floorBudget) break;
    included = nextCount;
  }
  return included === 0
    ? emptyNotice
    : `${SKILLS_LISTING_HEADING}\n\n${shortLines.slice(0, included).join("\n")}\n\n${omissionNotice(included, total)}`;
}

/** 列表的固定顺序：按显示名比较；locale 平手时按码元与用途稳定 tiebreak，保证增量指纹顺序确定。 */
export function sortSkillsForListing(skills: readonly SkillMetadata[]): SkillMetadata[] {
  return [...skills].sort((a, b) =>
    skillDisplayName(a).localeCompare(skillDisplayName(b)) ||
    compareCodeUnits(skillDisplayName(a), skillDisplayName(b)) ||
    compareCodeUnits(skillPurpose(a), skillPurpose(b)),
  );
}

/** 完整格式的一行；增量公告的指纹按这一行计算，不受预算降级影响。 */
export function formatSkillLine(
  skill: SkillMetadata,
  maxDescriptionChars = MAX_DESCRIPTION_CHARS,
): string {
  const description = skillPurpose(skill);
  let trimmed = description;
  if (description.length > maxDescriptionChars) {
    const end = maxDescriptionChars - DESCRIPTION_ELLIPSIS.length;
    // 字符预算使用 UTF-16 length，但不能把截断点上的代理对拆成无效 Unicode。
    trimmed = `${description.slice(0, end).replace(/[\uD800-\uDBFF]$/u, "")}${DESCRIPTION_ELLIPSIS}`;
  }
  return `- ${skillDisplayName(skill)}: ${trimmed}${bareAliasSuffix(skill)} (file: ${skill.path})`;
}

export function skillDisplayName(skill: SkillMetadata): string {
  return skill.qualifiedName ?? skill.name;
}

function skillPurpose(skill: SkillMetadata): string {
  const purpose = [skill.description, skill.whenToUse]
    .map((part) => part?.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join(" - ");
  // 无 frontmatter 的兼容技能允许空描述；明确缺失，不凭名字猜用途或触发自动加载。
  return purpose || MISSING_SKILL_PURPOSE;
}

function bareAliasSuffix(skill: SkillMetadata): string {
  return skill.qualifiedName && skill.qualifiedName !== skill.name
    ? ` (also loadable as ${skill.name})`
    : "";
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function omissionNotice(included: number, total: number): string {
  return (
    `Showing ${included} of ${total} skills; the catalog is incomplete. ` +
    "A user's explicit exact name can still be loaded with Skill; do not guess names. " +
    "Use zcode skills list --json in the same working directory if command execution is available and zcode is installed and runnable. " +
    "CLI discovery may use different configuration; this session's Skill result determines availability."
  );
}
