import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 全局派生点必须已收口到 ZCODE_DATA_DIR_SEGMENT；allowlist 记录每个文件“合法残留”的
// 工作区字面量处数，防止误改工作区 .zcode 或漏改全局点（spec §2/§5 规则的机器化）。
const SWEEP_TARGETS: readonly string[] = [
  "src/commands/commandsService.ts",
  "src/hooks/hooksService.ts",
  "src/node.ts",
  "src/onboarding/localUsageEvidence.ts",
  "src/plugin-sync/pluginSyncService.ts",
  "src/session/sourceServerWorkspaceAliasRepo.ts",
  "src/settings-sync/settingsSyncService.ts",
  "src/skill-sync/skillSyncService.ts",
  "src/skills/skillsService.ts",
  "src/subagents/subagentStorage.ts",
  "src/subagents/subagentsService.ts",
  "src/zcode-agent/modelTrajectoryFileTail.ts",
  "src/zcode-agent/zcodeAgentService.ts",
  "src/zcode-agent/zcodeTaskServiceAdapter.ts",
  "src/storage/adapters/rootsResolver.ts",
  "src/mcp-sync/mcpSyncService.ts",
  "src/paths.ts",
  "src/setting/settingService.ts",
];

// 文件 → 改造后仍应存在的 `".zcode"` 字面量次数（已逐文件核对，全部是工作区作用域）
const REMAINING_LITERAL_COUNT: Record<string, number> = {
  "src/hooks/hooksService.ts": 2, // :59 workspacePath 分支 + :309 resolve(params.workspacePath, ".zcode", "config.json")
  "src/settings-sync/settingsSyncService.ts": 4, // 工作区 skills/commands/plugins/config.json 分支
  "src/skills/skillsService.ts": 1, // :74 join(workspacePath, ".zcode", "skills")
  "src/subagents/subagentStorage.ts": 1, // :24 join(workspacePath, ".zcode", "agents")
  "src/commands/commandsService.ts": 1, // :56 workspaceDirectorySegments
  "src/mcp-sync/mcpSyncService.ts": 1, // workspaceConfigDirSegments（userConfigDirSegments 已改）
};

describe("data dir segment sweep 守护", () => {
  it("全部全局派生点已 import segment 且字面量残留符合 allowlist", () => {
    for (const file of SWEEP_TARGETS) {
      const source = readFileSync(resolve(import.meta.dirname, "..", file), "utf8");
      expect(source, `${file} 应 import ZCODE_DATA_DIR_SEGMENT`).toContain(
        "ZCODE_DATA_DIR_SEGMENT",
      );
      const literalCount = (source.match(/"\.zcode"/g) ?? []).length;
      expect(literalCount, `${file} 残留 .zcode 字面量 ${literalCount} 处`).toBe(
        REMAINING_LITERAL_COUNT[file] ?? 0,
      );
    }
  });
});
