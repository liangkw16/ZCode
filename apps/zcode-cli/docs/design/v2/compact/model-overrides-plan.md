# Compact Model Overrides 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `compact` 配置实现 `modelOverrides`（providerId→modelId 精确匹配、白名单 4 字段），让主代理 / flash 子代理 / 128K 子代理在同一 Runtime 内各自触发压缩。

**Architecture:** 配置侧增量（contracts 类型 → adapters strict schema → merger 三层合并 → bootstrap 透传），核心侧新增纯函数 `applyCompactModelOverrides`，在 auto（`compact.ts`）与 micro（`microcompact.ts`）两个组装点按**实际执行模型**解析。窗口事实所有者不变（模型元数据），resolver 结果剥离 `modelOverrides` 键。

**Tech Stack:** TypeScript、zod strict schema、vitest；包：`@zcode/contracts`、`@zcode/adapters`、`@zcode/bootstrap`、`@zcode/core`（均在 `apps/zcode-cli/` 独立 workspace 内）。

**Spec:** [model-overrides-design.md](./model-overrides-design.md)（commit `007f7818`）。计划与 spec 同目录随行，执行者须同时读两者。

## Global Constraints

- 单包命令从 `apps/zcode-cli/` 目录执行（如 `pnpm --filter @zcode/core exec vitest run tests/compact-policy.test.ts`）；`pnpm typecheck` / `pnpm lint` / `pnpm verify:pre-push` 从仓库根目录执行。Node 版本以根目录 `mise.toml` 为准。
- strict schema：未知字段、空 providerId/modelId key 拒绝；数值规则与全局段完全一致（`contextWindowTokens`/`bufferTokens`/`outputReserveTokens` 正整数、`thresholdRatio` ∈ (0,1) 开区间；21K 输出预留上限由 policy 层 `getAutoCompactOutputReserveTokens` 的 min-cap 保证，schema 不重复校验——与全局段现状一致）。
- 未设置键必须剔除（omitUndefined 语义），不得以显式 `undefined` 覆盖模型窗口（bootstrap `resolveCompactPolicyConfig` 注释中的既有约束）。
- 不配置 `modelOverrides` 时所有行为与现状完全一致。
- 修复/新增行为的原因用中文注释（合并语义、透传处、resolver 处）。
- 日志遵循仓库规则：每 step 高频判定用 `debug` 级。
- 全部任务完成后根目录 `pnpm typecheck` 与 `pnpm lint` 必须真实通过。

## Review Focus

以下 5 类失败模式 spec 有隐含要求但各任务happy path 未必覆盖，已逐条钉到归属任务的测试里：

1. **override 结构泄漏/undefined 覆盖**：`modelOverrides` 键或未设置字段进入策略对象，把模型窗口覆盖成 `undefined` 回退 200K 兜底 → Task 4 测试（结果剥离 `modelOverrides` 键 + 未设置字段不覆盖）。
2. **大小写/未知 ID 误匹配**：`"glm-5.3"` 不应命中 `"GLM-5.3"` 的 override → Task 4 测试（case-sensitive 断言）。
3. **merger 浅覆盖吞条目**：Project 层只改一个模型的一个字段时，User 层其他 provider/model/字段丢失 → Task 2 测试（跨层保留断言）。
4. **micro 路径漏接**：`microcompact.ts` 组装点未接 resolver，micro 阈值仍按全局窗口计算 → Task 5 测试（override 生效后 micro 阈值 = 解析后阈值 × 0.9）。
5. **bootstrap 透传破坏 omitUndefined**：透传写成显式 `undefined` 键或漏透传 → Task 3 测试（`toMatchObject` 断言透传值；现有 "keeps unset keys absent" 测试已钉住未设置时无键）。

---

### Task 1: contracts 类型 + adapters strict schema

**Files:**
- Modify: `apps/zcode-cli/packages/contracts/src/config/index.ts`（`CompactRuntimeConfig` 区域，约 385-418 行）
- Modify: `apps/zcode-cli/packages/adapters/src/config/schema.ts`（`compactSchema`，约 231-267 行）
- Test: `apps/zcode-cli/packages/adapters/tests/config.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces: contracts 导出 `CompactModelOverride`（4 个可选字段）；`CompactRuntimeConfig.modelOverrides?: Record<string, Record<string, CompactModelOverride>>`。后续任务按此类型引用。

- [ ] **Step 1: 写失败测试**

在 `config.test.ts` 的 `it("loads the compact policy section from file config", ...)`（约 405 行）中，把写入的 compact 对象和期望对象都追加：

```ts
            modelOverrides: {
              "test-provider": {
                "cheap-model": { contextWindowTokens: 200_000 },
                "other-model": { thresholdRatio: 0.7 },
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
      { compact: { modelOverrides: "nope" } },
```

注意：`{ p: { m: {} } }`（空 override 对象）是合法 no-op，**不要**加入非法用例。

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
  /** providerId → modelId → 覆盖字段。未命中或字段缺省时继承本段全局值与模型窗口。 */
  modelOverrides?: Record<string, Record<string, CompactModelOverride>>;
```

`adapters/src/config/schema.ts`，在 `compactSchema` 定义之前新增：

```ts
// 与全局段数值规则完全一致；21K 输出预留上限由 policy 层 min-cap 保证，schema 不重复校验。
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

### Task 2: config-merger 三层合并

**Files:**
- Modify: `apps/zcode-cli/packages/adapters/src/config/config-merger.ts`（compact 合并分支，约 147-165 行）
- Test: `apps/zcode-cli/packages/adapters/tests/config.test.ts`（`mergeConfigs` 用例区，约 517 行起）

**Interfaces:**
- Consumes: Task 1 的 `CompactRuntimeConfig["modelOverrides"]` 类型。
- Produces: 合并后的 `RuntimeConfig.compact.modelOverrides`（三层逐字段合并语义，供 bootstrap 读取）。

- [ ] **Step 1: 写失败测试**

在现有 `mergeConfigs` 用例附近新增：

```ts
  it("merges compact.modelOverrides per provider, model and field across scopes", () => {
    const merged = mergeConfigs(
      {
        config: {
          compact: {
            modelOverrides: {
              "provider-a": {
                "Model-One": { contextWindowTokens: 400_000 },
                "Model-Two": { thresholdRatio: 0.8 },
              },
              "provider-b": { "Model-Three": { bufferTokens: 9_000 } },
            },
          },
        },
        scope: ConfigScope.User,
        priority: ConfigScopePriority[ConfigScope.User],
      },
      {
        config: {
          compact: {
            modelOverrides: { "provider-a": { "Model-One": { thresholdRatio: 0.76 } } },
          },
        },
        scope: ConfigScope.Project,
        priority: ConfigScopePriority[ConfigScope.Project],
      },
    );

    // Project 层只改 provider-a/Model-One 的一个字段：其余 provider、model、字段必须保留。
    expect(merged.compact?.modelOverrides).toEqual({
      "provider-a": {
        "Model-One": { contextWindowTokens: 400_000, thresholdRatio: 0.76 },
        "Model-Two": { thresholdRatio: 0.8 },
      },
      "provider-b": { "Model-Three": { bufferTokens: 9_000 } },
    });
  });
```

若 `ConfigScope.Project` 枚举成员名不同，以相邻 mergeConfigs 用例（约 517 行）实际使用的高优先级 scope 名为准替换。

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/adapters exec vitest run tests/config.test.ts`
Expected: FAIL——当前 `...config.compact` 浅 spread 整表替换，`provider-b` 与 `contextWindowTokens` 丢失。

- [ ] **Step 3: 最小实现**

`config-merger.ts` 新增模块级辅助函数（放在 merge 函数附近）：

```ts
// modelOverrides 是 provider→model→字段 三层结构：浅覆盖会让 Project 层只改一个模型的
// 一个字段时丢掉 User 层其他条目，与 microcompact 子对象是同一种坑，必须逐层合并。
function mergeCompactModelOverrides(
  previous: CompactRuntimeConfig["modelOverrides"],
  next: CompactRuntimeConfig["modelOverrides"],
): CompactRuntimeConfig["modelOverrides"] {
  const merged: NonNullable<CompactRuntimeConfig["modelOverrides"]> = { ...(previous ?? {}) };
  for (const [providerId, models] of Object.entries(next ?? {})) {
    merged[providerId] = { ...(merged[providerId] ?? {}) };
    for (const [modelId, override] of Object.entries(models)) {
      merged[providerId][modelId] = { ...(merged[providerId][modelId] ?? {}), ...override };
    }
  }
  return merged;
}
```

（`CompactRuntimeConfig` 类型按文件内既有 contracts 类型导入风格引入；若尚未导入则补 type import。）

compact 分支（约 147-165 行）改为：

```ts
    if (config.compact) {
      const previousModelOverrides = previousCompact?.modelOverrides;
      const nextModelOverrides = config.compact.modelOverrides;
      result.compact = {
        // Object.assign 已把 result.compact 指向当前高优先级层；必须从 previousCompact
        // 开始构造，否则低优先层只写 compact 顶层字段时会被整段覆盖丢失。
        ...previousCompact,
        ...config.compact,
        // modelOverrides 与 microcompact 同理：三层逐级合并，不做整表替换。
        ...((previousModelOverrides || nextModelOverrides)
          ? {
              modelOverrides: mergeCompactModelOverrides(
                previousModelOverrides,
                nextModelOverrides,
              ),
            }
          : {}),
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

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/adapters exec vitest run tests/config.test.ts`
Expected: PASS（新增用例与既有 compact 合并用例全部通过）。

- [ ] **Step 5: Commit**

```bash
git add apps/zcode-cli/packages/adapters/src/config/config-merger.ts apps/zcode-cli/packages/adapters/tests/config.test.ts
git commit -m "feat(cli): merge compact modelOverrides across config layers"
```

### Task 3: policy 类型 + bootstrap 透传

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/compact/policy.ts`（`AutoCompactPolicyConfig`，约 16-39 行）
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts`（`resolveCompactPolicyConfig`，约 232-265 行）
- Test: `apps/zcode-cli/packages/bootstrap/tests/runtime-config.test.ts`（`describe("resolveAppRuntimeConfig：compact 策略接线")`，约 740 行）

**Interfaces:**
- Consumes: Task 1 的 contracts 类型（bootstrap 侧结构兼容）。
- Produces: core 导出 `CompactModelOverrideInput`；`AutoCompactPolicyConfig.modelOverrides?: Record<string, Record<string, CompactModelOverrideInput>>`（Task 4/5 消费）。

- [ ] **Step 1: 写失败测试**

在 `describe("resolveAppRuntimeConfig：compact 策略接线")` 内新增：

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
```

（`workingDirectory`、`createCompactConfigResult` 沿用该 describe 现有用例的既有变量/辅助函数。）

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/bootstrap exec vitest run tests/runtime-config.test.ts`
Expected: FAIL——`runtimeConfig.compact` 中无 `modelOverrides` 键（透传缺失）。

- [ ] **Step 3: 最小实现**

`core/src/compact/policy.ts`，在 `AutoCompactPolicyConfig` 之前新增：

```ts
/** 与 contracts 的 CompactModelOverride 同构；本地定义避免 core 策略反向依赖 CLI 配置契约。 */
export interface CompactModelOverrideInput {
  contextWindowTokens?: number;
  thresholdRatio?: number;
  bufferTokens?: number;
  outputReserveTokens?: number;
}
```

`AutoCompactPolicyConfig` 内追加：

```ts
  /** providerId → modelId → 覆盖字段；由组装点按实际执行模型解析（applyCompactModelOverrides）。 */
  modelOverrides?: Record<string, Record<string, CompactModelOverrideInput>>;
```

`bootstrap/src/app/runtime-config.ts` 的 `resolveCompactPolicyConfig` 中 `omitUndefinedKeys({...})` 对象追加一行（`contextWindow: fileConfig?.contextWindowTokens,` 之后）：

```ts
    // modelOverrides 不在此解析：此处无模型身份，必须延迟到组装点按实际执行模型挑选，
    // 子代理才能拿到自己的策略而不是父代理的。
    modelOverrides: fileConfig?.modelOverrides,
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/bootstrap exec vitest run tests/runtime-config.test.ts`
Expected: PASS（含既有 "keeps unset keys absent"——未配置时无 `modelOverrides` 键）。

- [ ] **Step 5: Commit**

```bash
git add apps/zcode-cli/packages/core/src/compact/policy.ts apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts apps/zcode-cli/packages/bootstrap/tests/runtime-config.test.ts
git commit -m "feat(cli): pass compact modelOverrides into runtime policy config"
```

### Task 4: `applyCompactModelOverrides` 纯函数

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/compact/policy.ts`
- Modify: `apps/zcode-cli/packages/core/src/compact/index.ts`（barrel 导出；compact-policy.test.ts 经此导入）
- Test: `apps/zcode-cli/packages/core/tests/compact-policy.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `AutoCompactPolicyConfig.modelOverrides`。
- Produces: `applyCompactModelOverrides(config: AutoCompactPolicyConfig, model: { providerId: string; modelId: string }): { config: AutoCompactPolicyConfig; source: "model-override" | "global" }`（结果 config 不含 `modelOverrides` 键）。Task 5 两个组装点消费。

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
    const { config, source } = applyCompactModelOverrides(
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

  it("falls back to model defaults without overrides (128K subagent keeps 94K)", () => {
    const { config, source } = applyCompactModelOverrides(
      { contextWindow: 128_000, maxOutputTokens: 32_000 },
      { providerId: "p", modelId: "m" },
    );

    expect(source).toBe("global");
    // min(128K − 21K − 13K) = 94K，与未引入 modelOverrides 前完全一致。
    expect(getAutoCompactThreshold(config)).toBe(94_000);
  });

  it("matches provider and model ids case-sensitively", () => {
    const { source, config } = applyCompactModelOverrides(
      {
        ...baseConfig,
        modelOverrides: {
          "account:bigmodel-individual-coding-plan": {
            "GLM-5.3": { contextWindowTokens: 400_000 },
          },
        },
      },
      { providerId: "account:bigmodel-individual-coding-plan", modelId: "glm-5.3" },
    );

    expect(source).toBe("global");
    expect(config.contextWindow).toBe(1_000_000);
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
  source: "model-override" | "global";
}

/**
 * 按实际执行模型挑选 compact.modelOverrides 白名单字段：
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
  if (!override) return { config: rest, source: "global" };
  const resolved: AutoCompactPolicyConfig = { ...rest };
  if (override.contextWindowTokens !== undefined) {
    resolved.contextWindow = override.contextWindowTokens;
  }
  if (override.thresholdRatio !== undefined) resolved.thresholdRatio = override.thresholdRatio;
  if (override.bufferTokens !== undefined) resolved.bufferTokens = override.bufferTokens;
  if (override.outputReserveTokens !== undefined) {
    resolved.outputReserveTokens = override.outputReserveTokens;
  }
  return { config: resolved, source: "model-override" };
}
```

`compact/index.ts` barrel 中把 `applyCompactModelOverrides`（及类型 `CompactModelOverrideResolution`、`CompactModelOverrideInput`）加入 policy 的 re-export 列表。

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
- Test: `apps/zcode-cli/packages/core/tests/runtime-compact.test.ts`（auto 路径，参照约 1390-1430 行既有用例的 harness）
- Test: `apps/zcode-cli/packages/core/tests/microcompact.test.ts`（micro 路径，参照该文件既有 runtime 用例）
- Test: `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`（子代理独立解析，参照约 4017-4043 行既有的 128K 阈值断言用例）

**Interfaces:**
- Consumes: Task 4 的 `applyCompactModelOverrides`；`Model.providerId` / `Model.modelId`（`turn-model-step.ts:164` 已有同款用法）。
- Produces: 行为变更——两个组装点按实际执行模型解析阈值策略；`compact.policy_source` debug 日志。

- [ ] **Step 1: 写失败测试（auto 路径）**

在 `runtime-compact.test.ts` 中，复制约 1390-1430 行既有 `autoCompactIfNeeded` 用例的 runtime 构造与调用骨架（`createTestAgentRuntime`、`runtimeInternals.autoCompactIfNeeded` 的完整入参形状以该用例为准），仅做以下替换，新增用例：

```ts
  it("resolves compact.modelOverrides for the executing model at the auto compact assembly point", async () => {
    // runtime 构造：compact 配置改为
    //   { modelOverrides: { test: { "GLM-5.3": { contextWindowTokens: 240, bufferTokens: 10, outputReserveTokens: 20 } } } }
    // （不设 thresholdRatio；outputReserveTokens 显式下调以得到可测的小阈值。）
    // model 构造：createTestRuntimeModel({
    //   providerId: "test", modelId: "GLM-5.3", contextWindow: 200_000,
    //   generateText: async () => ({ finishReason: "stop", text: "" }),
    // })
    // 消息构造：沿用相邻用例的历史注入方式，使估算 token 数落在 (210, 166_000) 区间
    //   ——例如注入约 300 token 的 user/assistant 消息。
    //
    // 断言：
    // expect(autoOutcome).not.toBe("skipped");            // override 阈值 240−20−10=210，300 > 210 → 压缩
    // 同一 runtime 换 providerId: "test", modelId: "other" 的 model 再跑一次：
    // expect(secondOutcome).toBe("skipped");              // 未命中 → 阈值 200K−21K−13K=166K，300 < 166K
  });
```

骨架与断言值必须落实为完整测试代码后再运行；上式给出全部关键值（210 / 166K / 300 token 落点），harness 调用形状照抄相邻用例。

- [ ] **Step 2: 写失败测试（micro 路径）**

在 `microcompact.test.ts` 中，参照既有"token 压力触发 microcompact"用例的构造方式新增：

```ts
  it("derives the microcompact threshold from the model-scoped auto threshold", async () => {
    // compact 配置：
    //   {
    //     microcompact: { enabled: true },
    //     modelOverrides: { test: { "GLM-5.3": { contextWindowTokens: 240, bufferTokens: 10, outputReserveTokens: 20 } } },
    //   }
    // model：providerId "test" / modelId "GLM-5.3" / contextWindow 200_000。
    // 消息：估算 token 落在 (189, ~180_000) 区间（210 × 0.9 = 189 为 micro 阈值）。
    //
    // 断言：产生 MicrocompactBoundary（或既有用例的等价观测点）；
    // 换 modelId: "other" 重跑：不产生 Boundary（全局 micro 阈值 = 166K × 0.9 ≈ 149K，未达）。
  });
```

再在 `subagent-explore.test.ts` 中，参照约 4017-4043 行"128K 子代理阈值 = 94K"的既有断言用例，新增兄弟用例（钉住"子代理用自己的模型身份解析，不复用父代理结果"）：

```ts
  it("resolves compact.modelOverrides with the subagent's own model identity", async () => {
    // 构造：沿用相邻用例的父/子代理骨架，compact 配置追加
    //   modelOverrides: { <子代理 providerId>: { <子代理 modelId>: { contextWindowTokens: 100_000 } } }
    // （modelOverrides 只指向子代理模型，不含父代理模型。）
    //
    // 断言（关键值）：
    // - 子代理阈值 = 100K − 21K − 13K = 66_000（override 命中，子代理用自己的身份解析）；
    // - 父代理阈值不变（其 modelId 未命中 override，按自身窗口计算）。
  });
```

- [ ] **Step 3: 运行确认失败**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/core exec vitest run tests/runtime-compact.test.ts tests/microcompact.test.ts tests/subagent-explore.test.ts`
Expected: FAIL——组装点未解析 override，auto/micro 均按模型原窗口（166K/149K）判断，首个断言不触发压缩。

- [ ] **Step 4: 实现**

`compact.ts`（约 193-200 行）组装改为：

```ts
  const { config, source: compactPolicySource } = applyCompactModelOverrides(
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
  // 每 step 高频判定，用 debug 级；policySource 说明阈值来自模型覆盖还是全局/模型默认。
  this.logger?.debug?.("Compact policy resolved", {
    event: "compact.policy_source",
    module: "core.runtime",
    policySource: compactPolicySource,
    providerId: context.model.providerId,
    modelId: context.model.modelId,
  });
```

（`this.logger` 若该类无此成员或无 `debug` 方法，以 microcompact.ts 现有 `this.logger?.info(...)` 的成员形态为准对齐；缺 debug 则按仓库日志规范补 debug 支持，不得改用 info。）

`microcompact.ts`（约 39-47 行）同样包裹：

```ts
  const autoConfig: AutoCompactPolicyConfig = applyCompactModelOverrides(
    {
      contextWindow: context.model.properties.contextWindow,
      ...this.config.compact,
      maxOutputTokens: resolveNormalRequestMaxOutputTokens({
        modelMaxOutputTokens: context.model.optionSpecs.maxOutputTokens.max,
      }),
      modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
    },
    { providerId: context.model.providerId, modelId: context.model.modelId },
  ).config;
```

两个文件的 import 增加 `applyCompactModelOverrides`（来自 `../../compact/index.js`，与文件内既有 compact import 合并）。

- [ ] **Step 5: 运行确认通过**

Run: `cd apps/zcode-cli && pnpm --filter @zcode/core exec vitest run tests/runtime-compact.test.ts tests/microcompact.test.ts tests/subagent-explore.test.ts tests/compact-policy.test.ts`
Expected: PASS（含既有用例回归）。

- [ ] **Step 6: Commit**

```bash
git add apps/zcode-cli/packages/core/src/runtime/methods/compact.ts apps/zcode-cli/packages/core/src/runtime/methods/microcompact.ts apps/zcode-cli/packages/core/tests/runtime-compact.test.ts apps/zcode-cli/packages/core/tests/microcompact.test.ts apps/zcode-cli/packages/core/tests/subagent-explore.test.ts
git commit -m "feat(cli): resolve compact policy per executing model at assembly points"
```

### Task 6: 回归验证与文档链接

**Files:**
- Modify: `apps/zcode-cli/docs/design/v2/compact/README.md`（"文档定位"小节）
- 无代码改动（纯验证 + 文档）

**Interfaces:**
- Consumes: Task 1-5 全部产物。
- Produces: 无。

- [ ] **Step 1: README 链接**

在 `README.md` "文档定位"小节（plan.md 链接之后）追加一行：

```markdown
按模型覆盖阈值策略（`compact.modelOverrides`）的设计与实施见 [model-overrides-design.md](./model-overrides-design.md) 与 [model-overrides-plan.md](./model-overrides-plan.md)。
```

- [ ] **Step 2: 全量受影响测试**

Run（仓库根目录）: `pnpm verify:pre-push`
Expected: PASS。affected 选择命中 contracts/adapters/bootstrap/core 四包时必须实际运行其 UT；全量选中整个套件时按仓库 pre-push 约定说明并跳过 UT。

- [ ] **Step 3: 类型与 Lint**

Run（仓库根目录）: `pnpm typecheck && pnpm lint`
Expected: PASS（报告真实结果，不将既有失败写成通过）。

- [ ] **Step 4: Commit**

```bash
git add apps/zcode-cli/docs/design/v2/compact/README.md
git commit -m "docs(cli): link compact model-overrides design from compact README"
```
