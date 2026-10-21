# Compact Model Overrides 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `compact` 配置实现 `modelOverrides`（providerId→modelId 精确匹配、白名单 4 字段），让主会话切换模型与子代理各自触发压缩，不配置时行为与现状完全一致。

**Architecture:** 配置侧增量（contracts 类型 → adapters strict schema → 两条合并入口共用三层合并 helper → bootstrap 透传并处理程序化共存），核心侧新增纯函数 `applyCompactModelOverrides`，在 auto（`compact.ts`）与 micro（`microcompact.ts`）两个组装点按**实际执行模型**解析；子代理构造时只透传未解析的覆盖表。窗口事实所有者不变（模型元数据），resolver 结果剥离 `modelOverrides` 键。

**Tech Stack:** TypeScript、zod strict schema、vitest；包：`@zcode/contracts`、`@zcode/adapters`、`@zcode/bootstrap`、`@zcode/core`（均在 `apps/zcode-cli/` 独立 workspace 内）。

**Spec:** [model-overrides-design.md](./model-overrides-design.md)（含 2026-10-22 评审修订：子代理只继承 modelOverrides、程序化 override 存在时忽略 modelOverrides、21K 由 policy 层 cap、micro 公式 `max(0, min(⌊T×0.9⌋, T−2000))`）。执行者须同时读 spec 与本计划。

## Global Constraints

- 单包命令从 `apps/zcode-cli/` 目录执行（如 `pnpm --filter @zcode/core exec vitest run tests/compact-policy.test.ts`）；根目录命令（typecheck/lint）除外。Node 版本以根目录 `mise.toml` 为准。
- strict schema：未知字段、空 providerId/modelId key、零/负/小数/字符串数值拒绝；`thresholdRatio` ∈ (0,1) 开区间；`outputReserveTokens` schema 只校验正整数，21K 上限由 policy 层 `getAutoCompactOutputReserveTokens` 的 min-cap 生效（与全局段现状一致，schema 不重复）。
- 未设置键必须剔除（omitUndefined 语义），不得以显式 `undefined` 覆盖模型窗口/低层配置值。
- 不配置 `modelOverrides` 时所有行为与现状完全一致（含子代理：继续不接收任何 compact 配置）。
- 修改行为的原因用中文注释（合并语义、透传处、resolver 处、子代理接线处）。
- 日志遵循仓库规则：每 step 高频判定用 `debug` 级；程序化共存剔除用 `warn`。
- 验证要求（`apps/zcode-cli/AGENTS.md`）：CLI 代码变更除根验证矩阵外，必须运行 `pnpm --dir apps/zcode-cli typecheck`、`pnpm --dir apps/zcode-cli lint` 及受影响 CLI 包测试；本计划改动 CLI 公共配置，须运行 `pnpm --dir apps/zcode-cli test`（CLI 全量）。
- 全部任务完成后根目录 `pnpm typecheck` 与 `pnpm lint` 必须真实通过。

## Review Focus

以下失败模式 spec 有隐含要求但各任务 happy path 未必覆盖，已逐条钉到归属任务：

1. **程序化优先级反转**：bootstrap 里程序化 runtimeOverride 最后展开（最高优先）；组装点再把文件级 modelOverrides 叠上去会反超程序化值 → Task 3 测试（runtimeOverride 存在时 modelOverrides 被剔除）。
2. **子代理接线缺失/过度**：child 收不到覆盖表（D 方案对子代理无效），或反过来传入整套 compact 改变子代理现状 → Task 6 测试（child 只收 modelOverrides；未配置时 child compact 键不存在）。
3. **override 结构泄漏/undefined 覆盖**：`modelOverrides` 键或未设置字段进入策略对象，覆盖模型窗口回退 200K 兜底；merger 里显式 `undefined` 抹掉低层值 → Task 2（undefined 过滤 + 无变异）、Task 4（剥离键 + 未设置字段不覆盖）测试。
4. **大小写/同名误匹配**：`"glm-5.3"` 不命中 `"GLM-5.3"`；provider 不同而 modelId 相同互相串 → Task 4 测试（case-sensitive + 同名不串）。
5. **增量合并丢条目**：ConfigStore.merge（`adapters/src/config/index.ts` compact 分支）浅覆盖丢低层模型条目 → Task 2 测试（连续两次增量 merge）。

---

### Task 1: contracts 类型 + adapters strict schema

**Files:**
- Modify: `apps/zcode-cli/packages/contracts/src/config/index.ts`（`CompactRuntimeConfig` 区域，约 385-418 行）
- Modify: `apps/zcode-cli/packages/adapters/src/config/schema.ts`（`compactSchema`，约 231-267 行）
- Test: `apps/zcode-cli/packages/adapters/tests/config.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces: contracts 导出 `CompactModelOverride`（4 个可选字段）；`CompactRuntimeConfig.modelOverrides?: Record<string, Record<string, CompactModelOverride>>`。后续任务按此类型引用（core 直接复用该类型，不再重复定义）。

- [ ] **Step 1: 写失败测试**

在 `config.test.ts` 的 `it("loads the compact policy section from file config", ...)`（约 405 行）中，把写入的 compact 对象和期望对象都追加（注意 `"empty-model": {}` 是合法 no-op）：

```ts
            modelOverrides: {
              "test-provider": {
                "cheap-model": { contextWindowTokens: 200_000 },
                "other-model": { thresholdRatio: 0.7 },
                "empty-model": {},
              },
            },
```

在 `it("rejects invalid compact config with a fail-fast diagnostic", ...)`（约 458 行）的 `cases` 数组追加：

```ts
      { compact: { modelOverrides: { "": { m: { contextWindowTokens: 1 } } } } },
      { compact: { modelOverrides: { p: { "": { contextWindowTokens: 1 } } } } },
      { compact: { modelOverrides: { p: { m: { unknownField: 1 } } } } },
      { compact: { modelOverrides: { p: { m: { thresholdRatio: 0 } } } } },
      { compact: { modelOverrides: { p: { m: { thresholdRatio: 1 } } } } },
      { compact: { modelOverrides: { p: { m: { bufferTokens: -1 } } } } },
      { compact: { modelOverrides: { p: { m: { contextWindowTokens: 0 } } } } },
      { compact: { modelOverrides: { p: { m: { contextWindowTokens: 1.5 } } } } },
      { compact: { modelOverrides: { p: { m: { contextWindowTokens: "400000" } } } } },
      { compact: { modelOverrides: "nope" } },
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/adapters exec vitest run tests/config.test.ts`
Expected: FAIL——`modelOverrides` 被 strict schema 当作未知字段拒绝（合法用例 `loaded.loaded` 为 false）。

- [ ] **Step 3: 最小实现**

`contracts/src/config/index.ts`，在 `CompactRuntimeConfig` 之前新增：

```ts
/** 按模型覆盖的压缩阈值字段白名单；仅在 providerId+modelId 精确匹配（大小写敏感）时生效。 */
export interface CompactModelOverride {
  contextWindowTokens?: number;
  thresholdRatio?: number;
  bufferTokens?: number;
  outputReserveTokens?: number;
}
```

`CompactRuntimeConfig` 内（`microcompact?: ...` 之前）追加：

```ts
  /** providerId → modelId → 覆盖字段。未命中或字段缺省时继承本段全局值与模型窗口；
   *  空对象条目为合法 no-op，不会清除低层已声明的条目。 */
  modelOverrides?: Record<string, Record<string, CompactModelOverride>>;
```

`adapters/src/config/schema.ts`，在 `compactSchema` 定义之前新增：

```ts
// 与全局段数值规则完全一致；21K 输出预留上限由 policy 层 min-cap 生效，schema 不重复校验。
const compactModelOverrideSchema = z
  .object({
    contextWindowTokens: positiveIntegerSchema.optional(),
    bufferTokens: positiveIntegerSchema.optional(),
    outputReserveTokens: positiveIntegerSchema.optional(),
    thresholdRatio: compactRatioSchema.optional(),
  })
  .strict();
```

`compactSchema` 的 `.object({...})` 内（`microcompact` 之前）追加：

```ts
    modelOverrides: z
      .record(z.string().min(1), z.record(z.string().min(1), compactModelOverrideSchema))
      .optional(),
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/adapters exec vitest run tests/config.test.ts`
Expected: PASS（含新增合法/非法用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/zcode-cli/packages/contracts/src/config/index.ts apps/zcode-cli/packages/adapters/src/config/schema.ts apps/zcode-cli/packages/adapters/tests/config.test.ts
git commit -m "feat(cli): add compact modelOverrides config schema"
```

### Task 2: 两条合并入口共用三层合并 helper

**Files:**
- Create: `apps/zcode-cli/packages/adapters/src/config/compact-model-overrides-merge.ts`（helper 模块）
- Modify: `apps/zcode-cli/packages/adapters/src/config/config-merger.ts`（compact 合并分支，约 147-165 行）
- Modify: `apps/zcode-cli/packages/adapters/src/config/index.ts`（ConfigStore.merge 的 compact 分支，约 205-230 行）
- Test: `apps/zcode-cli/packages/adapters/tests/config.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `CompactRuntimeConfig["modelOverrides"]` 类型。
- Produces: `mergeCompactModelOverrides(previous, next): CompactRuntimeConfig["modelOverrides"] | undefined`（三层逐字段合并；过滤显式 `undefined` 值；不修改输入；两侧皆空时返回 `undefined`）。Task 2 内两个合并入口消费。

- [ ] **Step 1: 写失败测试**

在现有 `mergeConfigs` 用例（约 517 行）附近新增：

```ts
  it("merges compact.modelOverrides per provider, model and field across scopes", () => {
    const userLayer = {
      compact: {
        modelOverrides: {
          "provider-a": {
            "Model-One": { contextWindowTokens: 400_000 },
            "Model-Two": { thresholdRatio: 0.8 },
          },
          "provider-b": { "Model-Three": { bufferTokens: 9_000 } },
        },
      },
    };
    const projectLayer = {
      compact: {
        modelOverrides: { "provider-a": { "Model-One": { thresholdRatio: 0.76 } } },
      },
    };

    const merged = mergeConfigs(
      { config: userLayer, scope: ConfigScope.User, priority: ConfigScopePriority[ConfigScope.User] },
      { config: projectLayer, scope: ConfigScope.Project, priority: ConfigScopePriority[ConfigScope.Project] },
    );

    // Project 层只改 provider-a/Model-One 的一个字段：其余 provider、model、字段必须保留。
    expect(merged.compact?.modelOverrides).toEqual({
      "provider-a": {
        "Model-One": { contextWindowTokens: 400_000, thresholdRatio: 0.76 },
        "Model-Two": { thresholdRatio: 0.8 },
      },
      "provider-b": { "Model-Three": { bufferTokens: 9_000 } },
    });
    // 合并不修改输入对象。
    expect(userLayer.compact.modelOverrides?.["provider-a"]?.["Model-One"]).toEqual({
      contextWindowTokens: 400_000,
    });
  });

  it("keeps compact.modelOverrides across repeated incremental ConfigStore merges", () => {
    // 走 createConfig / ConfigStore.merge 的公开增量接口（参照 config.test.ts 中
    // createConfig 的既有用例构造），连续两次 merge：
    // 第一次：User 层写入 provider-a/{Model-One, Model-Two} 与 provider-b/Model-Three；
    // 第二次：Project 层只写 provider-a/Model-One 的 thresholdRatio。
    // 断言：第二次 merge 后 provider-b 与 Model-Two 条目仍在，Model-One 两个字段并存。
  });
```

（第二个用例按 ConfigStore 实际公开 API 落成完整代码；若 `mergeConfigs` 用例的 scope 枚举名不同，以相邻用例实际值为准。）

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/adapters exec vitest run tests/config.test.ts`
Expected: FAIL——两处浅 spread 整表替换，跨层/增量条目丢失。

- [ ] **Step 3: 最小实现**

新建 `compact-model-overrides-merge.ts`：

```ts
import type { CompactRuntimeConfig } from "@zcode/contracts";

type CompactModelOverrides = NonNullable<CompactRuntimeConfig["modelOverrides"]>;

// modelOverrides 是 provider→model→字段 三层结构：浅覆盖会让高优先层只改一个模型的
// 一个字段时丢掉低层其他条目，与 microcompact 子对象是同一种坑，必须逐层合并；
// 两条合并入口（启动 mergeConfigs 与 ConfigStore 增量 merge）必须共用本 helper，
// 否则公开增量接口与启动路径产生不同语义。
export function mergeCompactModelOverrides(
  previous: CompactModelOverrides | undefined,
  next: CompactModelOverrides | undefined,
): CompactModelOverrides | undefined {
  if (!previous && !next) return undefined;
  const merged: Record<string, Record<string, Record<string, number>>> = {
    ...((previous as Record<string, Record<string, Record<string, number>>>) ?? {}),
  };
  for (const [providerId, models] of Object.entries(
    (next as Record<string, Record<string, Record<string, number>>>) ?? {},
  )) {
    merged[providerId] = { ...(merged[providerId] ?? {}) };
    for (const [modelId, override] of Object.entries(models)) {
      const mergedOverride = { ...(merged[providerId][modelId] ?? {}) };
      for (const [field, value] of Object.entries(override)) {
        // 显式 undefined 不覆盖低层已配置值（omitUndefined 语义）。
        if (value !== undefined) mergedOverride[field] = value;
      }
      merged[providerId][modelId] = mergedOverride;
    }
  }
  return merged as CompactModelOverrides;
}
```

（类型签名可按文件风格收紧；语义必须保持：三层合并、undefined 过滤、不改输入、双侧皆空返回 undefined。）

`config-merger.ts` compact 分支改为（引用 helper，import 路径按包内相对路径风格）：

```ts
    if (config.compact) {
      const mergedModelOverrides = mergeCompactModelOverrides(
        previousCompact?.modelOverrides,
        config.compact.modelOverrides,
      );
      result.compact = {
        // Object.assign 已把 result.compact 指向当前高优先级层；必须从 previousCompact
        // 开始构造，否则低优先层只写 compact 顶层字段时会被整段覆盖丢失。
        ...previousCompact,
        ...config.compact,
        // modelOverrides 与 microcompact 同理：三层逐级合并，不做整表替换。
        ...(mergedModelOverrides !== undefined ? { modelOverrides: mergedModelOverrides } : {}),
        ...((previousCompact?.microcompact || config.compact.microcompact)
          ? {
              microcompact: {
                ...previousCompact?.microcompact,
                ...config.compact.microcompact,
              },
            }
          : {}),
      };
    }
```

`adapters/src/config/index.ts` 的 ConfigStore.merge compact 分支做同构修改（`previous` 来自 `this.get(ConfigKey.Compact)`，同样调用 `mergeCompactModelOverrides`，双侧皆空时不生成键）。

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/adapters exec vitest run tests/config.test.ts`
Expected: PASS（新增用例与既有 compact 合并用例全部通过）。

- [ ] **Step 5: Commit**

```bash
git add apps/zcode-cli/packages/adapters/src/config/compact-model-overrides-merge.ts apps/zcode-cli/packages/adapters/src/config/config-merger.ts apps/zcode-cli/packages/adapters/src/config/index.ts apps/zcode-cli/packages/adapters/tests/config.test.ts
git commit -m "feat(cli): merge compact modelOverrides across config layers and store"
```

### Task 3: bootstrap 透传与程序化共存剔除

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/compact/policy.ts`（`AutoCompactPolicyConfig`，约 16-39 行）
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts`（`resolveCompactPolicyConfig`，约 232-265 行）
- Test: `apps/zcode-cli/packages/bootstrap/tests/runtime-config.test.ts`（`describe("resolveAppRuntimeConfig：compact 策略接线")`，约 740 行）

**Interfaces:**
- Consumes: Task 1 的 contracts 类型（core 复用 `CompactModelOverride`，不重复定义）。
- Produces: `AutoCompactPolicyConfig.modelOverrides?: Record<string, Record<string, CompactModelOverride>>`（Task 4/5 消费；类型来自 `@zcode/contracts`）。

- [ ] **Step 1: 写失败测试**

在 `describe("resolveAppRuntimeConfig：compact 策略接线")` 内新增两个用例：

```ts
  it("passes compact.modelOverrides through for per-model resolution at assembly time", () => {
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createCompactConfigResult({
        compact: {
          thresholdRatio: 0.76,
          modelOverrides: {
            "account:bigmodel-individual-coding-plan": {
              "GLM-5.3": { contextWindowTokens: 400_000 },
            },
          },
        },
      }),
      options: {},
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
      workingDirectory,
    });

    expect(resolved.runtimeConfig.compact).toMatchObject({
      thresholdRatio: 0.76,
      modelOverrides: {
        "account:bigmodel-individual-coding-plan": {
          "GLM-5.3": { contextWindowTokens: 400_000 },
        },
      },
    });
  });

  it("drops compact.modelOverrides when a programmatic runtime override takes over", () => {
    // 程序化 runtimeOverride 是嵌入方对压缩行为的整体接管，优先级最高；
    // 文件级按模型例外不得反超（否则优先级反转），V1 直接剔除。
    const resolved = resolveAppRuntimeConfig({
      cliStorageRoot: "/tmp/zcode-cli",
      configResult: createCompactConfigResult({
        compact: {
          thresholdRatio: 0.76,
          modelOverrides: { p: { m: { contextWindowTokens: 400_000 } } },
        },
      }),
      options: { /* 按 resolveAppRuntimeConfig 既有用例传入程序化 compact override 的方式构造 */ },
      subagentOutputRootDir: "/tmp/zcode-cli/agents",
      subagentProfiles: [],
      workingDirectory,
    });

    expect(resolved.runtimeConfig.compact).not.toHaveProperty("modelOverrides");
  });
```

（第二个用例中程序化 override 的传入方式以 `resolveAppRuntimeConfig` 既有用例为准；若该函数没有程序化 compact 入口，则以 `resolveCompactPolicyConfig` 的真实调用方为准补测。）

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/bootstrap exec vitest run tests/runtime-config.test.ts`
Expected: FAIL——透传缺失（第一个用例无 `modelOverrides` 键）。

- [ ] **Step 3: 最小实现**

`core/src/compact/policy.ts`：顶部补 `import type { CompactModelOverride } from "@zcode/contracts";`（若 policy.ts 无 contracts 导入先例，参照 `runtime/methods/` 的导入路径），`AutoCompactPolicyConfig` 内追加：

```ts
  /** providerId → modelId → 覆盖字段；由组装点按实际执行模型解析（applyCompactModelOverrides）。 */
  modelOverrides?: Record<string, Record<string, CompactModelOverride>>;
```

`bootstrap/src/app/runtime-config.ts` 的 `resolveCompactPolicyConfig`：

```ts
function resolveCompactPolicyConfig(
  fileConfig: CompactRuntimeConfig | undefined,
  featuresCompact: boolean,
  runtimeOverride: AutoCompactPolicyConfig | undefined,
): AutoCompactPolicyConfig {
  const microcompact = fileConfig?.microcompact;
  const hasRuntimeOverride = runtimeOverride !== undefined;
  return omitUndefinedKeys({
    ...(microcompact ? { microcompact: omitUndefinedKeys({ ...microcompact }) } : {}),
    // modelOverrides 不在此解析：此处无模型身份，必须延迟到组装点按实际执行模型挑选。
    // 程序化 runtimeOverride 存在时整体接管压缩策略，文件级按模型例外一并剔除，
    // 否则组装点的覆盖会反超程序化值（优先级反转）。
    ...(hasRuntimeOverride ? {} : { modelOverrides: fileConfig?.modelOverrides }),
    bufferTokens: fileConfig?.bufferTokens,
    contextWindow: fileConfig?.contextWindowTokens,
    // ……其余字段映射保持原样……
    enabled: fileConfig?.enabled ?? featuresCompact,
    ...(runtimeOverride ?? {}),
  });
}
```

（保持函数其余字段不变；`microcompact` 子对象照旧展开各字段。若实现时选择在函数末尾统一 warn 日志，warn 内容注明"programmatic compact override active; modelOverrides ignored"。bootstrap 侧无 logger 时以现有诊断机制为准。）

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/bootstrap exec vitest run tests/runtime-config.test.ts`
Expected: PASS（含既有 "keeps unset keys absent"——未配置时无 `modelOverrides` 键）。

- [ ] **Step 5: Commit**

```bash
git add apps/zcode-cli/packages/core/src/compact/policy.ts apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts apps/zcode-cli/packages/bootstrap/tests/runtime-config.test.ts
git commit -m "feat(cli): pass compact modelOverrides into runtime policy, drop under programmatic override"
```

### Task 4: `applyCompactModelOverrides` 纯函数

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/compact/policy.ts`
- Modify: `apps/zcode-cli/packages/core/src/compact/index.ts`（barrel 导出）
- Test: `apps/zcode-cli/packages/core/tests/compact-policy.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `AutoCompactPolicyConfig.modelOverrides`。
- Produces: `applyCompactModelOverrides(config: AutoCompactPolicyConfig, model: { providerId: string; modelId: string }): { config: AutoCompactPolicyConfig; source: "model-override" | "global"; matched: boolean }`（结果 config 不含 `modelOverrides` 键；`matched` = 表中存在该模型条目（含空对象）；`source` = 应用至少一个字段后为 `"model-override"`，否则 `"global"`）。Task 5/6 消费。

- [ ] **Step 1: 写失败测试**

在 `compact-policy.test.ts` 顶部 import 中加入 `applyCompactModelOverrides`，文件末尾新增：

```ts
describe("applyCompactModelOverrides", () => {
  const baseConfig = {
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    thresholdRatio: 0.76,
    modelContextBudgetStrategy: "preflight-v1" as const,
  };

  it("applies the matching override and reproduces the 400K policy threshold", () => {
    const { config, source, matched } = applyCompactModelOverrides(
      {
        ...baseConfig,
        modelOverrides: {
          "account:bigmodel-individual-coding-plan": {
            "GLM-5.3": { contextWindowTokens: 400_000 },
          },
        },
      },
      { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3" },
    );

    expect(source).toBe("model-override");
    expect(matched).toBe(true);
    expect(config.contextWindow).toBe(400_000);
    // min(400K − 21K − 13K, floor(400K × 0.76)) = 304K，即官方评测口径触发点。
    expect(getAutoCompactThreshold(config)).toBe(304_000);
  });

  it("keeps the model window when only non-window fields are overridden", () => {
    const { config } = applyCompactModelOverrides(
      { ...baseConfig, modelOverrides: { p: { m: { bufferTokens: 9_000 } } } },
      { providerId: "p", modelId: "m" },
    );

    expect(config.contextWindow).toBe(1_000_000);
    expect(config.bufferTokens).toBe(9_000);
    // min(1M − 21K − 9K, floor(1M × 0.76)) = 760K。
    expect(getAutoCompactThreshold(config)).toBe(760_000);
  });

  it("applies ratio-only policy to a 200K window (152K)", () => {
    const { config } = applyCompactModelOverrides(
      {
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        thresholdRatio: 0.76,
      },
      { providerId: "p", modelId: "m" },
    );

    // 无覆盖表时 ratio 直接作用于模型窗口：min(166K, 152K)。
    expect(getAutoCompactThreshold(config)).toBe(152_000);
  });

  it("falls back to model defaults without overrides (128K keeps 94K)", () => {
    const { config, source, matched } = applyCompactModelOverrides(
      { contextWindow: 128_000, maxOutputTokens: 32_000 },
      { providerId: "p", modelId: "m" },
    );

    expect(source).toBe("global");
    expect(matched).toBe(false);
    expect(getAutoCompactThreshold(config)).toBe(94_000);
  });

  it("matches provider and model ids case-sensitively and per-provider", () => {
    const modelOverrides = {
      "account:bigmodel-individual-coding-plan": { "GLM-5.3": { contextWindowTokens: 400_000 } },
      "other-provider": { "GLM-5.3": { bufferTokens: 9_000 } },
    };

    // modelId 大小写不同：不命中。
    const lower = applyCompactModelOverrides(
      { ...baseConfig, modelOverrides },
      { providerId: "account:bigmodel-individual-coding-plan", modelId: "glm-5.3" },
    );
    expect(lower.matched).toBe(false);
    expect(lower.config.contextWindow).toBe(1_000_000);

    // 同名 modelId 挂在其他 provider：不命中前者，只命中自己 provider 的条目。
    const otherProvider = applyCompactModelOverrides(
      { ...baseConfig, modelOverrides },
      { providerId: "other-provider", modelId: "GLM-5.3" },
    );
    expect(otherProvider.matched).toBe(true);
    expect(otherProvider.config.contextWindow).toBe(1_000_000);
    expect(otherProvider.config.bufferTokens).toBe(9_000);
  });

  it("treats an empty override entry as matched but global", () => {
    const { source, matched } = applyCompactModelOverrides(
      { ...baseConfig, modelOverrides: { p: { m: {} } } },
      { providerId: "p", modelId: "m" },
    );

    // 空对象条目存在（matched 便于诊断），但没有任何字段被应用。
    expect(matched).toBe(true);
    expect(source).toBe("global");
  });

  it("honors explicit outputReserveTokens down-cap", () => {
    const { config } = applyCompactModelOverrides(
      {
        contextWindow: 100_000,
        maxOutputTokens: 32_000,
        modelOverrides: { p: { m: { outputReserveTokens: 2_000 } } },
      },
      { providerId: "p", modelId: "m" },
    );

    // 显式 reserve 2000：100K − 2K − 13K = 85K（无 ratio）。
    expect(getAutoCompactThreshold(config)).toBe(85_000);
  });

  it("strips the modelOverrides key from the resolved policy", () => {
    const { config } = applyCompactModelOverrides(
      { ...baseConfig, modelOverrides: { p: { m: { bufferTokens: 9_000 } } } },
      { providerId: "p", modelId: "m" },
    );

    // 配置结构不能泄漏进阈值计算与后续 spread。
    expect(Object.hasOwn(config, "modelOverrides")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/core exec vitest run tests/compact-policy.test.ts`
Expected: FAIL——`applyCompactModelOverrides` 未导出。

- [ ] **Step 3: 最小实现**

`policy.ts` 新增（`getAutoCompactThreshold` 之后）：

```ts
export interface CompactModelOverrideResolution {
  /** 已剥离 modelOverrides 键的策略；未命中时与输入（除该键外）等价。 */
  config: AutoCompactPolicyConfig;
  /** model-override = 应用了至少一个覆盖字段；global = 未应用（含空对象条目）。 */
  source: "model-override" | "global";
  /** 覆盖表中存在该 providerId+modelId 条目（含空对象），用于诊断未命中/空条目。 */
  matched: boolean;
}

/**
 * 按实际执行模型挑选 compact.modelOverrides 白名单字段（纯函数，不查 Registry、
 * 不写日志、不改 Model.properties）：
 * - providerId+modelId 精确匹配，大小写敏感，无通配；
 * - 未设置的字段剔除，不得以 undefined 覆盖模型窗口或全局值（omitUndefined 语义）；
 * - 结果剥离 modelOverrides 键，避免配置结构泄漏进阈值计算。
 */
export function applyCompactModelOverrides(
  config: AutoCompactPolicyConfig,
  model: { providerId: string; modelId: string },
): CompactModelOverrideResolution {
  const { modelOverrides: overrides, ...rest } = config;
  const override = overrides?.[model.providerId]?.[model.modelId];
  if (!override) return { config: rest, source: "global", matched: false };
  const resolved: AutoCompactPolicyConfig = { ...rest };
  let applied = false;
  if (override.contextWindowTokens !== undefined) {
    resolved.contextWindow = override.contextWindowTokens;
    applied = true;
  }
  if (override.thresholdRatio !== undefined) {
    resolved.thresholdRatio = override.thresholdRatio;
    applied = true;
  }
  if (override.bufferTokens !== undefined) {
    resolved.bufferTokens = override.bufferTokens;
    applied = true;
  }
  if (override.outputReserveTokens !== undefined) {
    resolved.outputReserveTokens = override.outputReserveTokens;
    applied = true;
  }
  return { config: resolved, source: applied ? "model-override" : "global", matched: true };
}
```

`compact/index.ts` barrel 中把 `applyCompactModelOverrides` 与 `CompactModelOverrideResolution` 加入 policy 的 re-export 列表。

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/core exec vitest run tests/compact-policy.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/zcode-cli/packages/core/src/compact/policy.ts apps/zcode-cli/packages/core/src/compact/index.ts apps/zcode-cli/packages/core/tests/compact-policy.test.ts
git commit -m "feat(cli): add applyCompactModelOverrides policy resolver"
```

### Task 5: 组装点接入（auto + micro）与判定日志

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/compact.ts`（约 193-200 行组装处）
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/microcompact.ts`（约 39-47 行组装处）
- Test: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`（auto 阈值遥测断言，参照约 3069-3166 行含 `autoCompactThreshold` 断言的既有用例；micro 组装与 boundary，参照约 3796 行组装测试与 3931 行 boundary 测试）

**Interfaces:**
- Consumes: Task 4 的 `applyCompactModelOverrides`；`Model.providerId` / `Model.modelId`（`turn-model-step.ts:164` 已有同款用法）。
- Produces: 行为变更——两个组装点按实际执行模型解析阈值策略；既有判定日志新增 `policySource`、`modelOverrideMatched` 字段。

- [ ] **Step 1: 写失败测试（auto 阈值）**

在 `runtime-compact.test.ts` 中，参照约 3069-3166 行既有用例（其断言含 `autoCompactThreshold: 109`）的 runtime 构造与观测点，新增用例（骨架照抄相邻用例，替换以下关键值）：

```ts
  it("resolves compact.modelOverrides for the executing model at the auto compact assembly point", async () => {
    // runtime 构造：compact 配置为
    //   {
    //     modelOverrides: {
    //       test: { "GLM-5.3": { contextWindowTokens: 24_000, bufferTokens: 1_000, outputReserveTokens: 2_000 } },
    //     },
    //   }
    // model：createTestRuntimeModel({ providerId: "test", modelId: "GLM-5.3", contextWindow: 200_000,
    //   generateText: 返回非空摘要文本（相邻用例的可摘要轮组构造） })
    //
    // 断言：auto 判定的阈值遥测/观测点报 21_000
    //   （24K − 2K − 1K；未命中时全局阈值为 200K − 21K − 13K = 166_000，两者拉开差距）。
    // 同一 runtime 换 providerId: "test", modelId: "other" 的 model、重建相同历史再跑：
    //   阈值观测点报 166_000（未命中回退全局/模型默认）。
    // 注意：两次调用之间必须重建相同历史（第一次若触发压缩会改变第二次输入）；
    // 断言用精确值（21_000 / 166_000），不用 .not.toBe("skipped") 这类宽断言。
  });
```

- [ ] **Step 2: 写失败测试（micro 阈值）**

在 `runtime-compact.test.ts` 的 microcompact 组装测试区（约 3796 行起）与 boundary 测试（约 3931 行）模式上新增：

```ts
  it("derives the microcompact threshold from the model-scoped auto threshold", async () => {
    // 构造约束（全部必须满足，否则测试无效）：
    // - compact 配置：{ microcompact: { enabled: true, keepRecentToolResults: 1, minTokenSavings: <小值> },
    //                  modelOverrides: { test: { "GLM-5.3": { contextWindowTokens: 24_000, bufferTokens: 1_000, outputReserveTokens: 2_000 } } } }
    //   不设置 microcompact.thresholdTokens（否则绕过默认阈值推导）。
    // - model：providerId "test" / modelId "GLM-5.3" / contextWindow 200_000。
    // - 历史含至少一个可清理的旧工具结果（Read/Bash 等可压缩工具，且在 keepRecentToolResults 之外）。
    // - 控制 idle 条件（lastAssistantCompletedAtMs 设为近期），避免 60 分钟时间触发掩盖 token 压力。
    // - 估算 token 落在 (18_900, 149_400) 区间：命中 override 时 micro 阈值
    //   M(21_000) = max(0, min(⌊21_000×0.9⌋, 21_000−2_000)) = 18_900 触发；
    //   未命中时全局阈值 166_000 → M = 149_400 不触发。
    //
    // 断言：命中场景产生 MicrocompactBoundary（或既有等价观测点）；
    // 换 modelId: "other" 重建相同历史重跑：不产生 Boundary。
  });
```

- [ ] **Step 3: 运行确认失败**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/core exec vitest run tests/runtime-compact.test.ts`
Expected: FAIL——组装点未解析 override，auto/micro 均按模型原窗口（166K / 149.4K）判断，命中场景断言不成立。

- [ ] **Step 4: 实现**

`compact.ts`（约 193-200 行）组装改为：

```ts
  const { config, source: compactPolicySource, matched: compactModelOverrideMatched } =
    applyCompactModelOverrides(
      {
        contextWindow: context.model.properties.contextWindow,
        ...this.config.compact,
        maxOutputTokens: resolveNormalRequestMaxOutputTokens({
          modelMaxOutputTokens: context.model.optionSpecs.maxOutputTokens.max,
        }),
        modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
      },
      { providerId: context.model.providerId, modelId: context.model.modelId },
    );
  // 每 step 高频判定，用 debug 级；把策略来源并入既有判定日志字段（threshold 等），
  // 不单独新增一条 info。
```

并在 auto 判定落日志/遥测处（该文件既有 decision 记录点）增加字段：

```ts
  policySource: compactPolicySource,
  modelOverrideMatched: compactModelOverrideMatched,
```

`microcompact.ts`（约 39-47 行）同样包裹（micro 不丢弃 source 信息，传入后续日志）：

```ts
  const { config: autoConfig, source: compactPolicySource, matched: compactModelOverrideMatched } =
    applyCompactModelOverrides(
      {
        contextWindow: context.model.properties.contextWindow,
        ...this.config.compact,
        maxOutputTokens: resolveNormalRequestMaxOutputTokens({
          modelMaxOutputTokens: context.model.optionSpecs.maxOutputTokens.max,
        }),
        modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
      },
      { providerId: context.model.providerId, modelId: context.model.modelId },
    );
```

`resolveLocalMicrocompactConfig(autoConfig)` 的调用与后续逻辑不变；micro 既有 `compact.micro.*` 日志增加 `policySource` / `modelOverrideMatched` 字段。两个文件的 import 增加 `applyCompactModelOverrides`（来自 `../../compact/index.js`，与文件内既有 compact import 合并）。

- [ ] **Step 5: 运行确认通过**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/core exec vitest run tests/runtime-compact.test.ts tests/compact-policy.test.ts`
Expected: PASS（含既有用例回归）。

- [ ] **Step 6: Commit**

```bash
git add apps/zcode-cli/packages/core/src/runtime/methods/compact.ts apps/zcode-cli/packages/core/src/runtime/methods/microcompact.ts apps/zcode-cli/packages/core/tests/runtime-compact.test.ts
git commit -m "feat(cli): resolve compact policy per executing model at assembly points"
```

### Task 6: 子代理只透传 modelOverrides

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`（child runtime 构造 config，约 273 行起）
- Test: `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`（参照约 4017-4043 行"128K 子代理阈值 = 94K"的既有断言用例）

**Interfaces:**
- Consumes: 父 runtime `this.config.compact`（含 modelOverrides）；child 自行调用 Task 5 已接入的组装点。
- Produces: child runtime 的 `compact` 配置仅含 `modelOverrides`（未配置时不设 compact 键）。

- [ ] **Step 1: 写失败测试**

在 `subagent-explore.test.ts` 中，参照约 4017-4043 行既有用例（128K 子代理默认阈值 94K 断言）新增兄弟用例：

```ts
  it("resolves compact.modelOverrides with the subagent's own model identity", async () => {
    // 构造：沿用相邻用例的父/子代理骨架；父 runtime compact 配置为
    //   { modelOverrides: { <child providerId>: { <child modelId>: { contextWindowTokens: 100_000 } } } }
    // （覆盖表只指向 child 模型。）
    //
    // 断言（关键值）：
    // - child auto 阈值观测点报 66_000（100K − 21K − 13K；child 用自己的身份解析命中）；
    // - 父 runtime 阈值不受影响（父模型 modelId 未命中，按父窗口计算）。
  });

  it("keeps child compact config absent without modelOverrides", async () => {
    // 构造：父 compact 配置只有全局字段（如 thresholdRatio: 0.76），无 modelOverrides。
    // 断言：child runtime 的 compact 配置不存在（或等价观测：child 阈值仍为默认 94K），
    // 全局阈值字段不得经子代理接线泄漏，维持"不配置 modelOverrides 行为不变"。
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/core exec vitest run tests/subagent-explore.test.ts`
Expected: FAIL——child 不接收任何 compact 配置，命中场景断言 66K 不成立。

- [ ] **Step 3: 实现**

`subagent.ts` child runtime 构造 config 对象中（`modelStreaming` 等继承字段附近）追加：

```ts
            // child 只继承未解析的 modelOverrides 覆盖表：全局阈值字段继续不传（维持现状，
            // 否则老用户配置的全局字段会改变子代理压缩节奏）；child 在组装点用自己的
            // Active Model 解析，父代理解析结果不传给 child。
            ...(this.config.compact?.modelOverrides
              ? { compact: { modelOverrides: this.config.compact.modelOverrides } }
              : {}),
```

（确认 AgentRuntime 构造 config 的类型接受 `compact` 字段——主 runtime 与 child 用同一构造器；若类型不含该字段需先补类型定义。）

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/core exec vitest run tests/subagent-explore.test.ts tests/runtime-compact.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts apps/zcode-cli/packages/core/tests/subagent-explore.test.ts
git commit -m "feat(cli): pass compact modelOverrides table to subagent runtimes"
```

### Task 7: 回归验证与文档链接

**Files:**
- Modify: `apps/zcode-cli/docs/design/v2/compact/README.md`（"文档定位"小节）
- 无代码改动（验证 + 文档）

**Interfaces:**
- Consumes: Task 1-6 全部产物。
- Produces: 无。

- [ ] **Step 1: README 链接并提交**

在 `README.md` "文档定位"小节（plan.md 链接之后）追加一行：

```markdown
按模型覆盖阈值策略（`compact.modelOverrides`）的设计与实施见 [model-overrides-design.md](./model-overrides-design.md) 与 [model-overrides-plan.md](./model-overrides-plan.md)。
```

```bash
git add apps/zcode-cli/docs/design/v2/compact/README.md
git commit -m "docs(cli): link compact model-overrides design from compact README"
```

（先提交文档：pre-push 检查要求干净工作区。）

- [ ] **Step 2: CLI 自身验证（apps/zcode-cli/AGENTS.md 要求）**

Run: `pnpm --dir apps/zcode-cli typecheck && pnpm --dir apps/zcode-cli lint`
Expected: PASS。

Run: `pnpm --dir apps/zcode-cli test`
（本次改动 CLI 公共配置契约，按 CLI AGENTS.md 跑 CLI 全量测试。）
Expected: PASS，报告真实结果。

- [ ] **Step 3: 根目录验证**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS（报告真实结果，不将已有失败写成通过）。

- [ ] **Step 4: pre-push 检查（工作区须干净）**

Run: `pnpm verify:pre-push`
Expected: PASS。affected 选择命中 contracts/adapters/bootstrap/core 时必须实际运行其 UT；全量选中整个套件时按仓库 pre-push 约定说明并跳过 UT。
