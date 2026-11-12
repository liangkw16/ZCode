# KCode 数据层镜像隔离（完全独立）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** kcode flavor 的所有全局数据（设置/远控身份/凭据/会话/插件/skills/agent db）落到镜像根 `~/.kcode`，与 zcode 的 `~/.zcode` 完全隔离；默认构建行为零变化。

**Architecture:** 编译期 segment 常量 `__ZCODE_DATA_DIR_SEGMENT__`（默认 `".zcode"`，`ZCODE_KCODE_IDENTITY=1` 构建折叠为 `".kcode"`）经 tsup/vite（desktop main/host）与 CLI esbuild define（agent bundle）注入；所有**全局**（home/dataBaseDir 相对）`.zcode` 派生点收口到该常量；**工作区相对** `.zcode` 与真实 HOME 一律不动。

**Tech Stack:** TypeScript、Vitest、tsup、esbuild、electron-builder；Node 经 `mise exec`。

**Spec:** `docs/superpowers/specs/2026-10-20-kcode-full-isolation-design.md`

## Global Constraints

- 默认构建（production/preview）一切路径仍为 `.zcode`；未注入 define 的 bundle/测试回落 `".zcode"`（spec §2、§7）。
- 只改 `join(<home | dataBaseDir | homePath | envHome>, ".zcode", ...)` 的全局派生点；`join(<workingDirectory | workspacePath | workspace>, ".zcode", ...)` 保持字面量（spec §2、§5）。
- 不改 `process.env.HOME`；不迁移旧数据（spec §2、§7）。
- segment 唯一事实源：`packages/desktop/scripts/desktop-product-identity.mjs`。
- CLI 侧（apps/zcode-cli）类型检查/测试在 `apps/zcode-cli` 内用自己的工具链跑；根仓命令用 `mise exec -- node scripts/mise-run.mjs pnpm <cmd>`。
- 每个 Task 结束必须 `git commit`；提交信息中文说明背景。

## Review Focus

1. **工作区路径误改**：若把 `join(workingDirectory, ".zcode")` 也换成 segment，kcode 打开项目就读不到项目级配置（plugins/subagents/workflows）。→ Task 4 Step 1 的静态 sweep 测试对每个文件断言**剩余** `.zcode` 字面量的精确处数（hooksService 保留 1 处 workspace 分支；memory-file-path 等工作区文件不在清单）。
2. **bundle 间 segment 不一致**（main 折叠了 .kcode、agent 没折叠）→ 数据脑裂。→ Task 9 Step 3 对打包产物做字符串断言：main bundle 与 `bundled-agents/*/glm/zcode.cjs` 都含 `.kcode` 且不再含 `join(..., ".zcode"` 的全局形态。
3. **模块加载期常量**：`skillsService.ts:50-51` 在 import 时求值，测试必须 `vi.resetModules()` 后带 stub 重新 import。→ Task 4 Step 2 测试模板强制 importFresh。
4. **无 define 环境静默回落**：源码直跑（dev CLI、单测）回落 `.zcode`，若误判为 bug 会加错兜底。→ Task 1/6 的回落测试钉死该语义。
5. **exportLogs 打包段错位**：zip 内相对路径（`posix.join(".zcode","cli","log")`）若漏改，导出日志标签与实际来源不一致。→ Task 5 Step 1 覆盖绝对路径与 zip 相对段两组；同时同步改 `shouldApplyLogExportRetention` 的 `.zcode/cli/log/` 前缀识别（否则 KCode 导出恢复"全量打包旧日志"的性能问题）。
6. **描述符/常量型派生点**（codex 审查发现）：`ZCODE_AGENT_RUNTIME.nativeConfigDir`、`ZCODE_DATA_DIR_NAME`（storage roots）、CLI `ZCODE_DIR`、`SAVED_WORKFLOW_GLOBAL_DIR` 这类**常量值**不含 `join(...,".zcode")` 形态，纯 join 正则扫不到，漏改即 KCode 继续扫/删 ZCode 的文件。→ Task 2/4/6 显式列入并在守护测试登记 import。
7. **同常量服务两个作用域**：CLI `ZCODE_DIR` 同时拼 user（home）与 project（工作区）基座；直接改值会误改项目路径。→ Task 6 规定按 scope 参数分流（user→segment，project→`.zcode`），不允许直接改常量值。
8. **登录发起时 ZCode 可能持有 handler**（codex 审查发现）：app 启动自注册只是初始态；顺序「启动 KCode → 启动 ZCode → 在 KCode 发起登录」会把 OAuth 回调送进 ZCode（state 只存发起进程内）。→ Task 8（登录时接管 handler）：kcode flavor 打开登录窗口前重新 `setAsDefaultProtocolClient("zcode")`。

---

### Task 1: segment 单一事实源 + shared 常量 + desktop define 注入链

**Files:**
- Modify: `packages/desktop/scripts/desktop-product-identity.mjs`
- Modify: `packages/desktop/scripts/desktop-product-identity.d.mts`
- Modify: `packages/shared/src/env.ts`
- Modify: `packages/desktop/tsup.config.ts`、`packages/desktop/vite.config.ts`
- Test: `packages/desktop/test/desktopProductIdentity.test.ts`、`packages/shared/test/env.test.ts`、`packages/desktop/test/tsupChunkIsolation.test.ts`

**Interfaces:**
- Produces: `resolveDesktopDataDirSegment(env?: Record<string, string | undefined>): ".zcode" | ".kcode"`（identity 模块，flavor==="kcode" → `".kcode"`，其余 → `".zcode"`）；`ZCODE_DATA_DIR_SEGMENT: string`（`@zcode/shared` 导出）；编译期 define 名 `__ZCODE_DATA_DIR_SEGMENT__`。

- [ ] **Step 1: 写失败测试**

`packages/desktop/test/desktopProductIdentity.test.ts` 追加：

```ts
  it("数据目录 segment 跟随 flavor：kcode 用 .kcode，其余一律 .zcode", () => {
    expect(resolveDesktopDataDirSegment({ ZCODE_ENV: "production", ZCODE_KCODE_IDENTITY: "1" })).toBe(".kcode");
    expect(resolveDesktopDataDirSegment({ ZCODE_ENV: "production" })).toBe(".zcode");
    expect(resolveDesktopDataDirSegment({ ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: "1" })).toBe(".zcode");
    expect(resolveDesktopDataDirSegment({ ZCODE_ENV: "test" })).toBe(".zcode");
    expect(resolveDesktopDataDirSegment({})).toBe(".zcode");
  });
```

（import 列表加 `resolveDesktopDataDirSegment`。）

`packages/shared/test/env.test.ts` 追加：

```ts
  it("数据目录 segment：注入 .kcode 时透出，未注入回落 .zcode", async () => {
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", ".kcode");
    const env = await importFreshEnvModule();
    expect(env.ZCODE_DATA_DIR_SEGMENT).toBe(".kcode");
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", undefined);
    const fallback = await importFreshEnvModule();
    expect(fallback.ZCODE_DATA_DIR_SEGMENT).toBe(".zcode");
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `mise exec -- node_modules/.bin/vitest run packages/desktop/test/desktopProductIdentity.test.ts packages/shared/test/env.test.ts`
Expected: FAIL（`resolveDesktopDataDirSegment` 未导出 / `ZCODE_DATA_DIR_SEGMENT` 不存在）。

- [ ] **Step 3: 最小实现**

`desktop-product-identity.mjs`（在 `resolveDesktopArtifactSuffix` 后）：

```js
/**
 * 全局数据目录 segment：决定 `~/.zcode` 与 `~/.kcode` 镜像根。默认（含 preview）一律
 * `.zcode`，只有 kcode 自用档改用 `.kcode`，保证上游默认构建零变化。tsup/vite/agent
 * 构建统一从这里取值折叠成编译期常量，是唯一事实源。
 */
export function resolveDesktopDataDirSegment(env = process.env) {
  return resolveDesktopProductFlavor(env) === "kcode" ? ".kcode" : ".zcode";
}
```

`desktop-product-identity.d.mts` 追加：`export function resolveDesktopDataDirSegment(env?: Record<string, string | undefined>): ".zcode" | ".kcode";`

`packages/shared/src/env.ts`（仿 `ZCODE_PRODUCT_FLAVOR` 模式）：

```ts
declare const __ZCODE_DATA_DIR_SEGMENT__: string;
// …与既有 declare 合并放置…
/** 全局数据目录名（~/.zcode | ~/.kcode）；未注入 define 的 bundle（web、独立 CLI、测试）回落 .zcode。 */
export const ZCODE_DATA_DIR_SEGMENT =
  (typeof __ZCODE_DATA_DIR_SEGMENT__ !== "undefined"
    ? __ZCODE_DATA_DIR_SEGMENT__
    : ".zcode") as ".zcode" | ".kcode";
```

`tsup.config.ts`：`zcodeProductFlavor` 旁加 `const zcodeDataDirSegment = resolveDesktopDataDirSegment({ ...process.env, ZCODE_ENV: zcodeEnv });`（import 列表补 `resolveDesktopDataDirSegment`），`define` 对（main/host/preload 全部 entry）加 `__ZCODE_DATA_DIR_SEGMENT__: JSON.stringify(zcodeDataDirSegment)`。`vite.config.ts` 同理（renderer 不消费，但注入无害、保持与 tsup 同源）。

`tsupChunkIsolation.test.ts` 的 define 用例追加：

```ts
      expect(defines).toHaveProperty("__ZCODE_DATA_DIR_SEGMENT__");
      expect(['".zcode"', '".kcode"']).toContain(defines.__ZCODE_DATA_DIR_SEGMENT__);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `mise exec -- node_modules/.bin/vitest run packages/desktop/test/desktopProductIdentity.test.ts packages/shared/test/env.test.ts packages/desktop/test/tsupChunkIsolation.test.ts`
Expected: PASS 全部。

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/scripts/desktop-product-identity.mjs packages/desktop/scripts/desktop-product-identity.d.mts packages/shared/src/env.ts packages/desktop/tsup.config.ts packages/desktop/vite.config.ts packages/desktop/test packages/shared/test
git commit -m "feat(isolation): 数据目录 segment 单一事实源与编译期注入链"
```

---

### Task 2: services paths 核心收口（含 agent runtime 描述符）

**Files:**
- Modify: `packages/services/src/paths.ts:45-58,234-238,241-269`
- Modify: `packages/shared/src/zcode-agent-runtime.ts:32`
- Test: `packages/services/test/pathsDataDirSegment.test.ts`（新建）

**Interfaces:**
- Consumes: `ZCODE_DATA_DIR_SEGMENT`（`@zcode/shared`）。
- Produces: `getZCodeDataRootDir()` = `join(getDataBaseDir(), segment)`；`getAppConfigDir()`、`getConversationWorkspaceDir()`、`getProviderWorkspaceConfigDir()`、`copyDataDirectory()` 随之；`ZCODE_AGENT_RUNTIME.nativeConfigDir` 变为 `${segment}/cli`（优先分支，不改则 Task 2 断言 `getProviderWorkspaceConfigDir()` 仍返回 `.zcode/cli`）。后续 Task 的 services 收口都以此为参照实现。

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

async function importFreshPaths() {
  vi.resetModules();
  return await import("../src/paths.js");
}

describe("data dir segment（KCode 镜像根）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("注入 .kcode 时全局根镜像为 {base}/.kcode", async () => {
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", ".kcode");
    vi.stubEnv("ZCODE_DATA_BASE_DIR", "/tmp/kcode-base");
    const paths = await importFreshPaths();
    expect(paths.getZCodeDataRootDir()).toBe("/tmp/kcode-base/.kcode");
    expect(paths.getAppConfigDir()).toBe("/tmp/kcode-base/.kcode/v2");
    expect(paths.getConversationWorkspaceDir()).toBe("/tmp/kcode-base/.kcode/workspace/default");
    expect(paths.getProviderWorkspaceConfigDir()).toBe("/tmp/kcode-base/.kcode/cli");
  });

  it("未注入 segment 时保持 .zcode（默认构建零变化）", async () => {
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", undefined);
    vi.stubEnv("ZCODE_DATA_BASE_DIR", "/tmp/kcode-base");
    const paths = await importFreshPaths();
    expect(paths.getZCodeDataRootDir()).toBe("/tmp/kcode-base/.zcode");
    expect(paths.getProviderWorkspaceConfigDir()).toBe("/tmp/kcode-base/.zcode/cli");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `mise exec -- node_modules/.bin/vitest run packages/services/test/pathsDataDirSegment.test.ts`
Expected: FAIL（根仍为 `.zcode`）。

- [ ] **Step 3: 最小实现**

`paths.ts` 顶部 import 加 `ZCODE_DATA_DIR_SEGMENT`（from `@zcode/shared`）。改动：

```ts
/** {dataBaseDir}/{ZCODE_DATA_DIR_SEGMENT}（默认 .zcode；kcode 构建为 .kcode 镜像根） */
export function getZCodeDataRootDir(): string {
  return join(getDataBaseDir(), ZCODE_DATA_DIR_SEGMENT);
}
```

`getProviderWorkspaceConfigDir()` 的 fallback 分支 `".zcode"` 同换 `ZCODE_DATA_DIR_SEGMENT`；**优先分支**修描述符——`packages/shared/src/zcode-agent-runtime.ts:32` 改：

```ts
import { ZCODE_DATA_DIR_SEGMENT } from "./env.js";
// …descriptor 内：
  nativeConfigDir: `${ZCODE_DATA_DIR_SEGMENT}/cli`,
```

（env.js 不反向依赖本模块，无循环导入。）`copyDataDirectory()` 内 `join(oldBaseDir, ".zcode", "v2")` / `join(newBaseDir, ".zcode", "v2")` 同换。

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令，Expected: PASS）

- [ ] **Step 5: Commit**

```bash
git add packages/services/src/paths.ts packages/shared/src/zcode-agent-runtime.ts packages/services/test/pathsDataDirSegment.test.ts
git commit -m "feat(isolation): services 全局数据根与 agent 描述符收口到编译期 segment"
```

---

### Task 3: 设置链路收口（setting.json / 远控身份 / 启动 bootstrap）

**Files:**
- Modify: `packages/services/src/setting/settingService.ts:228`
- Modify: `packages/desktop/src/main/desktopDataBaseDirBootstrap.ts:6-8`
- Modify: `packages/desktop/src/main/index.ts:573`
- Test: `packages/services/test/settingServiceSegment.test.ts`（新建）、`packages/desktop/test/desktopDataBaseDirBootstrap.test.ts`（新建）

**Interfaces:**
- Consumes: `ZCODE_DATA_DIR_SEGMENT`。
- Produces: 设置文件统一为 `{resolveUserHomeDir}/{segment}/v2/setting.json`；远控身份 `webRemoteControlRelayV2Device` 随文件隔离。

- [ ] **Step 1: 写失败测试**

`packages/services/test/settingServiceSegment.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

describe("settingService 路径 segment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("设置文件路径跟随 segment，未注入回落 .zcode", async () => {
    vi.stubEnv("ZCODE_DESKTOP_HOME_DIR", "/tmp/kcode-home");
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", ".kcode");
    vi.resetModules();
    const { resolveSettingsFilePath } = await import("../src/setting/settingService.js");
    expect(resolveSettingsFilePath()).toBe("/tmp/kcode-home/.kcode/v2/setting.json");
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", undefined);
    vi.resetModules();
    const fallback = await import("../src/setting/settingService.js");
    expect(fallback.resolveSettingsFilePath()).toBe("/tmp/kcode-home/.zcode/v2/setting.json");
  });
});
```

（前置：本测试依赖 Step 3 新增导出的 `resolveSettingsFilePath()`，见 Interfaces 与 Step 3。）

`packages/desktop/test/desktopDataBaseDirBootstrap.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

describe("desktopDataBaseDirBootstrap segment", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("bootstrap 设置文件跟随 segment", async () => {
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", ".kcode");
    vi.resetModules();
    const { resolveBootstrapSettingsFile } = await import(
      "../src/main/desktopDataBaseDirBootstrap.js"
    );
    expect(resolveBootstrapSettingsFile("/tmp/home")).toBe("/tmp/home/.kcode/v2/setting.json");
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", undefined);
    vi.resetModules();
    const fallback = await import("../src/main/desktopDataBaseDirBootstrap.js");
    expect(fallback.resolveBootstrapSettingsFile("/tmp/home")).toBe("/tmp/home/.zcode/v2/setting.json");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `mise exec -- node_modules/.bin/vitest run packages/services/test/settingServiceSegment.test.ts packages/desktop/test/desktopDataBaseDirBootstrap.test.ts`
Expected: FAIL（`resolveSettingsFilePath` 不存在 / 路径仍 `.zcode`）。

- [ ] **Step 3: 最小实现**

`settingService.ts`：新增导出（`resolveUserHomeDir` 旁）：

```ts
/** 设置文件路径唯一解析点：{home}/{segment}/v2/setting.json。远控设备身份存于此文件，
 *  KCode 镜像根下自成一套；desktop bootstrap 与 main 的 settingsFile 都从这里取。 */
export function resolveSettingsFilePath(): string {
  return join(resolveUserHomeDir(), ZCODE_DATA_DIR_SEGMENT, "v2", "setting.json");
}
```

`createSettingServiceWithMigrations` 里 `const settingsFile = ...` 改为 `const settingsFile = resolveSettingsFilePath();`。import `ZCODE_DATA_DIR_SEGMENT`（`@zcode/shared`）。

`desktopDataBaseDirBootstrap.ts` 的 `resolveBootstrapSettingsFile` 改为 `join(homePath, ZCODE_DATA_DIR_SEGMENT, "v2", "setting.json")`（import 同上）。

`packages/desktop/src/main/index.ts:573` 的 `const settingsFile = join(homedir(), ".zcode", "v2", "setting.json")` 改为 `const settingsFile = resolveSettingsFilePath()`（从 `@zcode/services/node` 或 settingService 模块 import，取该文件现有 import 风格一致的入口；若 services/node.ts 未透出，则在 `packages/services/src/node.ts` 追加 `export { resolveSettingsFilePath } from "./setting/settingService.js";`）。

- [ ] **Step 4: 跑测试确认通过 + 回归既有设置测试**

Run: `mise exec -- node_modules/.bin/vitest run packages/services/test/settingServiceSegment.test.ts packages/desktop/test/desktopDataBaseDirBootstrap.test.ts packages/services/test packages/desktop/test/desktopRuntimeEnv.test.ts`
Expected: 新测试 PASS；既有失败仅为此前基线确认的 3 个本地免签 CUA 用例。

- [ ] **Step 5: Commit**

```bash
git add packages/services/src/setting/settingService.ts packages/services/src/node.ts packages/desktop/src/main/desktopDataBaseDirBootstrap.ts packages/desktop/src/main/index.ts packages/services/test/settingServiceSegment.test.ts packages/desktop/test/desktopDataBaseDirBootstrap.test.ts
git commit -m "feat(isolation): 设置文件（含远控身份）随镜像根隔离"
```

---

### Task 4: services 其余全局派生点 sweep（14 文件）

**Files（全部 Modify，仅列需改行）：**
- `packages/services/src/commands/commandsService.ts:55,89`（:55 `userDirectorySegments` 的 `".zcode"` 改 segment；:56 `workspaceDirectorySegments` **保持**）
- `packages/services/src/hooks/hooksService.ts:59,168`（:59 仅 home 分支 `join(baseDir, ".zcode", "cli")`；workspace 分支 `join(baseDir, ".zcode")` **保持字面量**）
- `packages/services/src/node.ts:1136`
- `packages/services/src/onboarding/localUsageEvidence.ts:94`
- `packages/services/src/plugin-sync/pluginSyncService.ts:220,224`
- `packages/services/src/session/sourceServerWorkspaceAliasRepo.ts:302,304`
- `packages/services/src/settings-sync/settingsSyncService.ts`（全局 5 行：419,427,435,439,451；同文件 4 处工作区分支保持）
- `packages/services/src/skill-sync/skillSyncService.ts:134`
- `packages/services/src/skills/skillsService.ts:50,51,84`（:74 工作区分支保持）
- `packages/services/src/subagents/subagentStorage.ts:53`（:24 工作区分支保持）、`subagentsService.ts:410`
- `packages/services/src/zcode-agent/modelTrajectoryFileTail.ts:18-19`、`zcodeAgentService.ts:547`、`zcodeTaskServiceAdapter.ts:241`
- `packages/services/src/storage/adapters/rootsResolver.ts:9`（codex 审查补充：`ZCODE_DATA_DIR_NAME = ".zcode"` 常量被资源管理器 R1/R2 扫描与删除消费，漏改会让 KCode 清理 ZCode 的文件；导出名保留，值改为 import 的 `ZCODE_DATA_DIR_SEGMENT`）

**Interfaces:**
- Consumes: `ZCODE_DATA_DIR_SEGMENT`（`@zcode/shared`）。
- Produces: 无新接口；静态守护测试 `packages/services/test/dataDirSegmentSweep.test.ts`。

- [ ] **Step 1: 写失败的静态守护测试（先钉规则再改代码）**

`packages/services/test/dataDirSegmentSweep.test.ts`：

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 全局派生点必须已收口到 ZCODE_DATA_DIR_SEGMENT；allowlist 记录每个文件“合法残留”的
// 工作区字面量处数，防止误改工作区 .zcode 或漏改全局点（spec §2/§5 规则的机器化）。
const SWEEP_TARGETS: ReadonlyArray<{ file: string; importFrom: string }> = [
  { file: "src/commands/commandsService.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
  { file: "src/hooks/hooksService.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
  { file: "src/node.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
  { file: "src/onboarding/localUsageEvidence.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
  { file: "src/plugin-sync/pluginSyncService.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
  { file: "src/session/sourceServerWorkspaceAliasRepo.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
  { file: "src/settings-sync/settingsSyncService.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
  { file: "src/skill-sync/skillSyncService.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
  { file: "src/skills/skillsService.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
  { file: "src/subagents/subagentStorage.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
  { file: "src/subagents/subagentsService.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
  { file: "src/zcode-agent/modelTrajectoryFileTail.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
  { file: "src/zcode-agent/zcodeAgentService.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
  { file: "src/zcode-agent/zcodeTaskServiceAdapter.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
  { file: "src/storage/adapters/rootsResolver.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
  { file: "src/paths.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
  { file: "src/setting/settingService.ts", importFrom: "ZCODE_DATA_DIR_SEGMENT" },
];

// 文件 → 改造后仍应存在的 `".zcode"` 字面量次数（已逐文件核对，全部是工作区作用域；
// codex 审查修正：settingsSync 4、skills 1、subagentStorage 1、commands 1 为工作区分支残留）
const REMAINING_LITERAL_COUNT: Record<string, number> = {
  "src/hooks/hooksService.ts": 1, // :59 workspacePath 分支 join(baseDir, ".zcode")
  "src/settings-sync/settingsSyncService.ts": 4, // 工作区 skills/commands/plugins/AGENTS.md 分支
  "src/skills/skillsService.ts": 1, // :74 join(workspacePath, ".zcode", "skills")
  "src/subagents/subagentStorage.ts": 1, // :24 join(workspacePath, ".zcode", "agents")
  "src/commands/commandsService.ts": 1, // :56 workspaceDirectorySegments（:55 userDirectorySegments 要改）
};

describe("data dir segment sweep 守护", () => {
  it("全部全局派生点已 import segment 且字面量残留符合 allowlist", () => {
    for (const { file } of SWEEP_TARGETS) {
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `mise exec -- node_modules/.bin/vitest run packages/services/test/dataDirSegmentSweep.test.ts`
Expected: FAIL（各文件尚无 import、字面量数不符）。

- [ ] **Step 3: 机械替换**

每个文件：import 加 `ZCODE_DATA_DIR_SEGMENT`（`@zcode/shared`，合并进现有 import）；将清点行中 `join(<home 形参>, ".zcode", ...)` 的 `".zcode"` 换成 `ZCODE_DATA_DIR_SEGMENT`。特别注意：
- `skillsService.ts:50-51` 是模块级常量，直接替换字面量即可（同模块加载期求值，define 已就绪）。
- `hooksService.ts:59`：`return workspacePath ? join(baseDir, ".zcode") : join(baseDir, ZCODE_DATA_DIR_SEGMENT, "cli");`——**只改后半**。
- `commandsService.ts:55`：`userDirectorySegments: [ZCODE_DATA_DIR_SEGMENT, "commands"]`；:56 不动。
- `rootsResolver.ts`：`import { ZCODE_DATA_DIR_SEGMENT } from "@zcode/shared";` 后 `export const ZCODE_DATA_DIR_NAME = ZCODE_DATA_DIR_SEGMENT;`（导出名与两个 join 消费点保持不变）。
- `modelTrajectoryFileTail.ts:18-19`：候选数组两行都改（一行 homedir、一行 dataBaseDir，均为全局）。
- 每处改完顺手确认该行不是 `workingDirectory/workspacePath/workspace` 基座（是则回退并核对 allowlist 注释，说明理由后再动）。

- [ ] **Step 4: 跑守护测试 + 受影响 services 测试**

Run: `mise exec -- node_modules/.bin/vitest run packages/services/test/dataDirSegmentSweep.test.ts packages/services/test/pathsDataDirSegment.test.ts packages/services/test/settingServiceSegment.test.ts`
Expected: PASS。

- [ ] **Step 5: 全 services 测试回归 + Commit**

Run: `mise exec -- node_modules/.bin/vitest run packages/services/test`
Expected: 除既有基线失败外全 PASS（如有新增失败，用 `git stash` 基线比对确认归属后再处理）。

```bash
git add packages/services/src packages/services/test/dataDirSegmentSweep.test.ts
git commit -m "feat(isolation): services 全局 .zcode 派生点全量收口（工作区路径不动）"
```

---

### Task 5: desktop 收口（exportLogs / dev helper / sourceServerDirectory）

**Files:**
- Modify: `packages/desktop/src/main/exportLogs.ts:36,49,968,979,984,996`
- Modify: `packages/desktop/src/main/desktopRuntimeEnv.ts:536`
- Modify: `packages/desktop/src/host/sourceServerDirectory.ts:170`
- Test: `packages/desktop/test/exportLogsSegment.test.ts`（新建）

**Interfaces:**
- Consumes: `ZCODE_DATA_DIR_SEGMENT`（`@zcode/shared`）。

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

describe("exportLogs 数据目录 segment", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("全局 CLI 目录跟随 segment，未注入回落 .zcode", async () => {
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", ".kcode");
    vi.resetModules();
    const mod = await import("../src/main/exportLogs.js");
    expect(mod.resolveGlobalZCodeCliDir()).toBe(join(homedir(), ".kcode", "cli"));
    expect(mod.resolveCuaRunDir()).toBe(join(homedir(), ".kcode", "computer-use", "run"));
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", undefined);
    vi.resetModules();
    const fallback = await import("../src/main/exportLogs.js");
    expect(fallback.resolveGlobalZCodeCliDir()).toBe(join(homedir(), ".zcode", "cli"));
  });
});
```

（实现时把 `exportLogs.ts:36` 的私有函数改名为导出的 `resolveGlobalZCodeCliDir()`，`:49` 同理导出为 `resolveCuaRunDir()`；zip 相对段 968-996 行直接用 `ZCODE_DATA_DIR_SEGMENT` 拼 `posix.join`，由代码审读覆盖。）

- [ ] **Step 2: 跑测试确认失败**

Run: `mise exec -- node_modules/.bin/vitest run packages/desktop/test/exportLogsSegment.test.ts`
Expected: FAIL。

- [ ] **Step 3: 最小实现**

`exportLogs.ts`：36/49 行 `".zcode"` → `ZCODE_DATA_DIR_SEGMENT`（import from `@zcode/shared`）；968/979/984/996 行 `posix.join(".zcode", ...)` → `posix.join(ZCODE_DATA_DIR_SEGMENT, ...)`；**并同步改 `shouldApplyLogExportRetention`（约 :767）**：`normalizedArchivePath.startsWith(".zcode/cli/log/")` → `normalizedArchivePath.startsWith(`${ZCODE_DATA_DIR_SEGMENT}/cli/log/`)`（codex 审查发现：漏改则 KCode 的旧日志过滤失效，导出包重新塞满三天前的日志）。
`desktopRuntimeEnv.ts:536`：`join(homedir(), ".zcode")` → `join(homedir(), ZCODE_DATA_DIR_SEGMENT)`。
`sourceServerDirectory.ts:170`：`join(getDataBaseDir(), ".zcode", "v2", "tasks-index.sqlite")` → `join(getDataBaseDir(), ZCODE_DATA_DIR_SEGMENT, "v2", "tasks-index.sqlite")`。

- [ ] **Step 4: 跑测试确认通过 + desktop 回归**

Run: `mise exec -- node_modules/.bin/vitest run packages/desktop/test/exportLogsSegment.test.ts packages/desktop/test/desktopRuntimeEnv.test.ts`
Expected: 新测试 PASS；desktopRuntimeEnv 仅既有 3 个基线失败。

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/exportLogs.ts packages/desktop/src/main/desktopRuntimeEnv.ts packages/desktop/src/host/sourceServerDirectory.ts packages/desktop/test/exportLogsSegment.test.ts
git commit -m "feat(isolation): desktop 全局数据路径收口到 segment"
```

---

### Task 6: CLI 常量 + apps/zcode-cli sweep

**Files:**
- Create: `apps/zcode-cli/packages/contracts/src/dataDirSegment.ts`
- Test: `apps/zcode-cli/packages/contracts/tests/dataDirSegment.test.ts`（新建；apps/zcode-cli vitest include 只收 `packages/*/test|tests/**`，src 下不收集——codex 审查修正）
- Modify: `apps/zcode-cli/packages/contracts/src/tools/saved-workflow.ts:31`（`SAVED_WORKFLOW_GLOBAL_DIR = ".zcode/workflows"` → `${ZCODE_DATA_DIR_SEGMENT}/workflows`，同包内 import）
- Modify（全局派生行）：`apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts:288-289`、`adapters/src/device/cli-device-mid.ts:60`、`adapters/src/context/index.ts:237`、`adapters/src/storage/session-store/paths.ts:5`、`adapters/src/storage/workspace-hook-trust-store.ts:135`、`bootstrap/src/provider-endpoint-routing-source-headers.ts:49-50`、`cli/src/provider-runtime-env.ts:76,81,140`、`cli/src/clipboard-image.ts:33`、`cli/src/sea-runtime-tools.ts:69`、`bootstrap/src/app/script-workflow-tool-port.ts:318`、`bootstrap/src/app/script-workflow-utils.ts:174`
- Modify（scope 分流，codex 审查补充）：`adapters/src/skills/roots.ts:10,115`、`adapters/src/commands/roots.ts:10,115`——`ZCODE_DIR` 常量同时服务 user（home 基座）与 project（工作区基座）两个 scope，**不允许直接改常量值**；在 `skillRootsForBase`/对应函数内按 scope 分流：`join(baseDirectory, scope === "user" ? ZCODE_DATA_DIR_SEGMENT : ZCODE_DIR, ...)`（两个文件的 `ZCODE_DIR` 调用处均带 scope 参数，函数签名无需改）

**Interfaces:**
- Produces: `ZCODE_DATA_DIR_SEGMENT: ".zcode" | ".kcode"`（`@zcode/contracts` 导出；esbuild define `__ZCODE_DATA_DIR_SEGMENT__` 替换，无 define 回落 `".zcode"`）。CLI 内各包 import 路径按现有惯例（`@zcode/contracts` 或深路径）。

- [ ] **Step 1: 写失败测试**

`apps/zcode-cli/packages/contracts/tests/dataDirSegment.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

async function importFresh() {
  vi.resetModules();
  return await import("../src/dataDirSegment.js");
}

describe("CLI 数据目录 segment", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("define 注入 .kcode 时透出；未注入回落 .zcode", async () => {
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", ".kcode");
    expect((await importFresh()).ZCODE_DATA_DIR_SEGMENT).toBe(".kcode");
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", undefined);
    expect((await importFresh()).ZCODE_DATA_DIR_SEGMENT).toBe(".zcode");
  });

  it("saved-workflow 全局目录前缀跟随 segment", async () => {
    vi.stubGlobal("__ZCODE_DATA_DIR_SEGMENT__", ".kcode");
    const { SAVED_WORKFLOW_GLOBAL_DIR } = await import("../src/tools/saved-workflow.js");
    expect(SAVED_WORKFLOW_GLOBAL_DIR).toBe(".kcode/workflows");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/zcode-cli && mise exec -- node_modules/.bin/vitest run packages/contracts/tests/dataDirSegment.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 最小实现**

`dataDirSegment.ts`：

```ts
declare const __ZCODE_DATA_DIR_SEGMENT__: string;

/**
 * 全局数据目录 segment（~/.zcode | ~/.kcode）。desktop agent bundle 构建时由
 * scripts/build-desktop-agent-cli.mjs 注入 define 折叠；独立 CLI/测试无 define 回落
 * .zcode。单一事实源是根仓 desktop-product-identity.mjs 的 resolveDesktopDataDirSegment。
 */
export const ZCODE_DATA_DIR_SEGMENT =
  (typeof __ZCODE_DATA_DIR_SEGMENT__ !== "undefined"
    ? __ZCODE_DATA_DIR_SEGMENT__
    : ".zcode") as ".zcode" | ".kcode";
```

桶导出后，逐文件把清点行的 `".zcode"` 换成 `ZCODE_DATA_DIR_SEGMENT`（import 按各包现有风格）。**保持不动**：`plugins.ts` 的 workingDirectory 分支与 `basename(...) === ".zcode"` 判等、`subagents.ts`/`script-workflow-*` 的 workingDirectory 分支、`builtin-prompt-command.ts`、`persistent-memory.ts`、`memory-file-path.ts`、`plan-file-continuity.ts`、`office-runtime/files.ts`（base 为工作区）、`workspace-hook-review-mutation.ts`（workingDirectory）。`script-workflow-tool-port.ts:318` 与 `script-workflow-utils.ts:174` 只改 `join(homedir(), ".zcode", ...)` 那一行。

- [ ] **Step 4: CLI 测试 + 类型检查**

Run: `cd apps/zcode-cli && mise exec -- ../../node_modules/.bin/tsc -p packages/contracts --noEmit && mise exec -- ../../node_modules/.bin/tsc -p packages/adapters --noEmit && mise exec -- ../../node_modules/.bin/tsc -p packages/bootstrap --noEmit && mise exec -- ../../node_modules/.bin/tsc -p packages/cli --noEmit`
Expected: 0 错误。再跑受影响包既有测试：`mise exec -- node_modules/.bin/vitest run packages/contracts packages/adapters/src/storage packages/adapters/src/auth`（以各包实际 test 脚本为准，无则以上述根仓 vitest 路径运行）。

- [ ] **Step 5: Commit**

```bash
git add apps/zcode-cli/packages/contracts apps/zcode-cli/packages/adapters/src apps/zcode-cli/packages/bootstrap/src apps/zcode-cli/packages/cli/src
git commit -m "feat(isolation): CLI 全局数据根随 segment（工作区路径与判等不动）"
```

---

### Task 7: agent 构建链 define 注入

**Files:**
- Modify: `scripts/build-desktop-agent-cli.mjs`（`pnpmRunEnv` 处）
- Modify: `apps/zcode-cli/packages/cli/scripts/build.mjs`（define 块）
- Modify: `apps/zcode-cli/turbo.json`（codex 审查发现：turbo 任务 `env` 白名单只有 `ZCODE_ENV`/`NODE_ENV`，严格模式会过滤新变量、宽松模式变化也不失效缓存；`ZCODE_DESKTOP_AGENT_BUILD_MODE=turbo` 路径下 agent 会打出与 main 不一致的 segment）

**Interfaces:**
- Consumes: `resolveDesktopDataDirSegment`（identity 模块）。

- [ ] **Step 1: 注入**

`build-desktop-agent-cli.mjs` 顶部 import 加 `resolveDesktopDataDirSegment`（从 `../packages/desktop/scripts/desktop-product-identity.mjs`），`pnpmRunEnv` 改为：

```js
const pnpmRunEnv = {
  ...process.env,
  ZCODE_ENV: await resolveBuiltinProviderBuildEnvironment({ root: repoRoot }),
  // agent bundle 的数据目录 segment 必须与 desktop main/host 同源同值，否则 agent 与
  // host 写两套根（spec §9 一致性风险）。
  ZCODE_DATA_DIR_SEGMENT: resolveDesktopDataDirSegment(process.env),
};
```

`apps/zcode-cli/packages/cli/scripts/build.mjs` define 块加：

```js
      __ZCODE_DATA_DIR_SEGMENT__: JSON.stringify(process.env.ZCODE_DATA_DIR_SEGMENT?.trim() || ".zcode"),
```

`apps/zcode-cli/turbo.json`：把构建链相关任务（含 `"env": ["ZCODE_ENV", "NODE_ENV"]` 的 build 任务，约 :43）的数组补 `"ZCODE_DATA_DIR_SEGMENT"`；如存在其他承载 agent 构建的 env 白名单任务一并补齐。

- [ ] **Step 2: 构建冒烟断言**

Run:
```bash
cd /Users/bytedance/BBB/zcode-proxy/ZCode && ZCODE_ENV=production ZCODE_KCODE_IDENTITY=1 mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/desktop prepare:agent-bundle && grep -c '"\.kcode"' packages/desktop/bundled-agents/*/glm/zcode.cjs
```
Expected: grep 计数 ≥ 1（agent bundle 已折叠 `.kcode`）。

- [ ] **Step 3: 无开关回落冒烟**

Run: `mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/desktop prepare:agent-bundle && grep -c 'ZCODE_DATA_DIR_SEGMENT' packages/desktop/bundled-agents/*/glm/zcode.cjs || echo "fallback-ok"`
Expected: 默认构建 bundle 中 segment 值为 `".zcode"`（抽查 `grep -o '"\.zcode"' ... | head -1`）。

- [ ] **Step 4: Commit**

```bash
git add scripts/build-desktop-agent-cli.mjs apps/zcode-cli/packages/cli/scripts/build.mjs apps/zcode-cli/turbo.json
git commit -m "feat(isolation): agent bundle 构建注入数据目录 segment define（含 turbo env）"
```

---

### Task 8: 登录发起时接管 zcode:// handler（kcode flavor）

**Files:**
- Modify: `packages/desktop/src/main/desktopHostProcess.ts`（login 窗口创建处，约 :120-148）
- Test: `packages/desktop/test/desktopLoginHandlerRegistration.test.ts`（新建）

**Interfaces:**
- Consumes: `isKcodePackagedRuntime`（`./desktopRuntimeEnv.js`，已存在）；electron `app.setAsDefaultProtocolClient`（`desktopOAuthDeepLink.ts` 已在启动期使用）。

**背景（codex 审查发现）**：每个 app 启动时自注册为 `zcode://` 默认 handler，但顺序「启动 KCode → 启动 ZCode（取走 handler）→ 在 KCode 发起登录」会把 OAuth 回调送进 ZCode，而 OAuth state 只存在发起进程内，KCode 登录无法完成。因此 kcode flavor 必须在**发起登录时**重新接管 handler。

- [ ] **Step 1: 写失败测试**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

const setDefaultMock = vi.fn();
const appMock = { isPackaged: true, setAsDefaultProtocolClient: setDefaultMock };

vi.mock("electron", () => ({ app: appMock, BrowserWindow: vi.fn() }));
// desktopRuntimeEnv 的 kcode 判定读编译期 ZCODE_PRODUCT_FLAVOR（mock 见下）
vi.mock("@zcode/shared", () => ({
  get ZCODE_PRODUCT_FLAVOR() {
    return "kcode";
  },
}));

describe("kcode 登录时接管 zcode:// handler", () => {
  afterEach(() => {
    vi.resetModules();
    setDefaultMock.mockClear();
  });

  it("打开 login 窗口前 kcode 打包态重新注册默认 handler", async () => {
    const { ensureDeepLinkHandlerForLogin } = await import("../src/main/desktopHostProcess.js");
    ensureDeepLinkHandlerForLogin();
    expect(setDefaultMock).toHaveBeenCalledWith("zcode");
  });
});
```

（实现时从 `desktopHostProcess.ts` 抽出导出 `ensureDeepLinkHandlerForLogin()`：`if (!isKcodePackagedRuntime) return; app.setAsDefaultProtocolClient("zcode")` + 日志；在 `page === "login"` 的窗口创建分支调用它。若该文件 electron mock 形态与上面不符，以现有 `desktopRuntimeEnv.test.ts` 的 mock 方式为准调整。）

- [ ] **Step 2: 跑测试确认失败**

Run: `mise exec -- node_modules/.bin/vitest run packages/desktop/test/desktopLoginHandlerRegistration.test.ts`
Expected: FAIL（函数不存在）。

- [ ] **Step 3: 最小实现**

`desktopHostProcess.ts`（import `isKcodePackagedRuntime` from `./desktopRuntimeEnv.js`、`app` from `electron`）：

```ts
/**
 * KCode 与 ZCode 共用 zcode:// scheme，系统默认 handler 是"最后注册者"。
 * app 启动期的自注册只是初始态：若 KCode 先启动、ZCode 后启动，发起登录时回调会落进
 * ZCode，而 OAuth state 只存在发起进程内，KCode 登录永远无法完成。因此在 kcode 打包态
 * 打开登录窗口前重新接管 handler（官方 ZCode 构建不受影响）。
 */
export function ensureDeepLinkHandlerForLogin(): void {
  if (!isKcodePackagedRuntime) return;
  const ok = app.setAsDefaultProtocolClient("zcode");
  // 复用该文件既有 logger 输出注册结果。
}
```

在创建 login 页窗口（`page === "login"`）的分支、加载 URL 之前调用。

- [ ] **Step 4: 跑测试确认通过**

Run: `mise exec -- node_modules/.bin/vitest run packages/desktop/test/desktopLoginHandlerRegistration.test.ts packages/desktop/test/desktopRuntimeEnv.test.ts`
Expected: 新测试 PASS；desktopRuntimeEnv 仅既有 3 个基线失败。

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/main/desktopHostProcess.ts packages/desktop/test/desktopLoginHandlerRegistration.test.ts
git commit -m "feat(isolation): kcode 登录发起时重新接管 zcode:// 默认 handler"
```

---

### Task 9: spec 勘误与文档更新

**Files:**
- Modify: `docs/superpowers/specs/2026-10-20-kcode-full-isolation-design.md`

**Interfaces:** 无。

- [ ] **Step 1: 勘误与补记三处**

1. §4.3 credential-cipher 段更正：镜像布局不改变 `homedir()`，fallback key 两边相同；隔离由凭据文件分属两个根实现，key 相同反而支持手动拷贝凭据播种（记录此事实，删除「互不可解密」的错误论断）。
2. §4.1 补记 CUA 结论：开源 `zcode-cua` 包与 `cuaHelperInstaller` 均无 `~/.zcode` 直连（Helper 安装根在闭源 producer，个人构建不打包 Helper，variant env 已隔离），CUA 安装根收口一项确认无需改动、出范围。
3. §4 改动面补记（计划期查证）：`packages/shared/src/zcode-agent-runtime.ts`（nativeConfigDir）、`packages/services/src/storage/adapters/rootsResolver.ts`（storage R1/R2 根）、CLI `skills/commands roots`（scope 分流）、`contracts/src/tools/saved-workflow.ts`（全局 workflows 前缀）、`turbo.json`（segment 进 env 白名单）、登录时接管 handler（desktopHostProcess）——已并入实施计划对应任务。

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-10-20-kcode-full-isolation-design.md
git commit -m "docs(isolation): spec 勘误与计划期查证补记"
```

---

### Task 10: 全量验证 + 构建 + 本机验收

**Files:** 无源码改动（验证任务）。

- [ ] **Step 1: 仓库级验证（对齐 verify:pre-push 全量组成）**

Run:
```bash
mise exec -- node scripts/mise-run.mjs pnpm typecheck
mise exec -- node scripts/mise-run.mjs pnpm lint
mise exec -- node scripts/mise-run.mjs pnpm db:schema:check
mise exec -- node scripts/mise-run.mjs pnpm test:architecture
mise exec -- node scripts/mise-run.mjs pnpm architecture:check -- --changed
mise exec -- node_modules/.bin/vitest run packages/services/test packages/shared/test/env.test.ts packages/desktop/test/desktopProductIdentity.test.ts packages/desktop/test/desktopDataBaseDirBootstrap.test.ts packages/desktop/test/exportLogsSegment.test.ts packages/desktop/test/desktopLoginHandlerRegistration.test.ts packages/desktop/test/desktopRuntimeEnv.test.ts
```
Expected: typecheck/lint(0 errors)/schema/architecture 全 OK；测试除 3 个既有基线失败（本地免签 CUA）外全 PASS。

- [ ] **Step 2: 默认构建零变化抽查**

Run: `grep -o '"\.zcode"' packages/desktop/out/main/index.js | head -1`（用默认 env 重建 bundle 后）
Expected: 默认构建 main bundle 内 segment 折叠为 `".zcode"`。

- [ ] **Step 3: kcode 构建 + 产物一致性断言**

Run:
```bash
ZCODE_ENV=production ZCODE_KCODE_IDENTITY=1 mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/desktop build
grep -c '"\.kcode"' packages/desktop/out/main/index.js
grep -c '"\.kcode"' packages/desktop/bundled-agents/*/glm/zcode.cjs
cd packages/desktop && ZCODE_ENV=production ZCODE_KCODE_IDENTITY=1 npm_config_user_agent="pnpm/10.33.2" mise exec -- node ../../node_modules/electron-builder/out/cli/cli.js --mac zip --config electron-builder.config.js
```
Expected: 两个 grep 均 ≥ 1；打包成功出 `KCode-*.zip`。

- [ ] **Step 4: 安装与验收（spec §8）**

```bash
ditto packages/desktop/dist/mac-arm64/KCode.app /Applications/KCode.app && open -a /Applications/KCode.app
# A1: 记录 ~/.zcode 最新 mtime 基线 → KCode 使用 10 分钟 → find ~/.zcode -newer <基线标记> 应为空；
#     ls ~/.kcode 应出现 v2/ cli/ 等
# A2: KCode 内完成一次独立登录（KCode 是最近启动的 app 时 OAuth 回调落入 KCode），凭据落 ~/.kcode
# A3: ZCode 与 KCode 同时开手机远控，各自扫码在线，无 session-conflict
# A4: KCode 内 Bash: echo $HOME（真实 HOME）、git config user.name（真实）、ssh -T 可用
# A5: 打开含项目 .zcode/config.json 的仓库，配置照常生效
# A6: 启动官方 ZCode 走一遍常用流程，无回归
```

- [ ] **Step 5: 文档收尾 + 提交推送**

`docs/desktop/zcode-preview-packaging.md` 追记小节记录数据层隔离落地与验收结果；提交：

```bash
git add docs/desktop/zcode-preview-packaging.md
git commit -m "docs(isolation): KCode 数据层镜像隔离落地记录"
```

推送：本 fork 缺 pre-push 钩子依赖的 origin/staging 分支，无法原样运行 `verify:pre-push`。已在其上方用显式基线跑完等价组成（lint、db:schema:check、test:architecture、architecture:check --changed、以及 `ZCODE_AFFECTED_TEST_BASE=<起始SHA> pnpm test:unit:affected --scope push`，基线机制见 docs/testing/pre-push-hook.md），之后：

```bash
git push --no-verify origin kcode
```

（如实记录：钩子未原样执行，等价五项已逐一运行并记录结果。）
