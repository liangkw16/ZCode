# ZCode 上下文压缩机制优化设计（评审稿）

- 日期：2026-10-20
- 状态：已实施（实现与本文一致，偏差见 §8 实现记录）
- 范围：`apps/zcode-cli` 压缩子系统（Auto Compact / Manual `/compact` / Microcompact）的参数可配置化与策略优化

## 1. 背景与问题

ZCode CLI 的上下文压缩机制功能完整（provider usage 锚点计数、rapid-refill 熔断、prompt 超长降级重试、持久化恢复），但存在一个核心缺口：

**全部阈值参数硬编码，没有任何配置入口。**

`AutoCompactPolicyConfig`（`apps/zcode-cli/packages/core/src/compact/policy.ts:16-26`）已定义 `enabled / contextWindow / maxOutputTokens / bufferTokens / maxConsecutiveFailures / microcompact.*` 等字段，策略层也已消费该类型；但：

- 配置文件 schema（`apps/zcode-cli/packages/adapters/src/config/schema.ts`）只有 `features.compact: boolean` 总开关，且该布尔值疑似未接线到 `AgentRuntimeConfig.compact.enabled`（`bootstrap/src/app/runtime-config.ts` 不构造 `compact` 字段；实现时需验证并修复）。
- 环境变量面（`adapters/src/config/env-config.adapter.ts`）无任何 compact 相关项。
- CLI 无相关 flag；仅 `/compact [instructions]` 斜杠命令支持自定义摘要指令。

### 1.1 当前硬编码参数清单

| 参数 | 当前值 | 位置 |
|---|---|---|
| 默认上下文窗口 | 200,000 | `core/src/compact/policy.ts:6` |
| 输出预留（正常） | 32,000（截到 21,000 上限） | `policy.ts:7-8` |
| 摘要 maxOutputTokens | 20,000 | `policy.ts:9` |
| 触发缓冲 bufferTokens | 13,000 | `policy.ts:10` |
| 200K 窗口实际触发点 | 166,000（83%） | `policy.ts:84-88` 推导 |
| auto 尝试次数 / 失败熔断 / rapid-refill 熔断 | 3 / 3 / 3 | `runtime/methods/compact-active.ts:77`、`policy.ts:11`、`turn-loop-state.ts:23-24` |
| 保留最近轮组（auto/reactive） | 1 组（轮次制） | `runtime/helpers/compact-selection.ts:36` |
| microcompact：保留组数 / 空闲阈值 / 最小节省 / 阈值比例 / 阈值缓冲 | 5 / 60min / 256 / 0.9 / 2,000 | `core/src/compact/microcompact.ts:12-29`（默认整体关闭） |
| token 估算除数 | 3 字符/token | `packages/shared/src/usage-stats.ts:9` |

## 2. 业界调研结论

| 维度 | Claude Code | Codex CLI | Anthropic Cookbook | pi | DeepSeek Harness | ZCode 现状 |
|---|---|---|---|---|---|---|
| 触发阈值 | ~95%（被认为太晚） | 按模型 token 上限 + 95% 边际 | `context_token_threshold` 可配（5k–150k 按任务） | `contextWindow - reserveTokens` | `min(W×0.8, W−O−65536)` 双帽 | 83%，不可配 |
| 保留近期消息 | 摘要替换全部 | 保留 ~20K tokens 原文 | 摘要替换全部 | `keepRecentTokens=40K` 可配 | `retainRatio=0.16` 或 `retainTokens`（互斥） | 固定 1 轮组，不可配 |
| 工具结果清理 | — | — | 官方推荐（单独 29% 提升） | 摘要时截断工具结果至 2000 字符 | 压力时先裁剪（头 4096+尾 1024），够则跳过摘要 | 已实现，默认关闭，不可配 |
| 摘要模型 | 当前模型 | 当前模型 | 建议可用便宜模型 | 当前模型 | `summarizationProvider/Model` 可配，回退当前模型 | 当前模型 |
| 配置校验 | — | — | — | — | 未知字段/冲突组合加载即报错 | — |
| 摘要输出预算 | — | — | — | `0.8×reserveTokens` | `maxTokens=65536` 可配 | 固定 20,000 |

主要参考：Claude Code/Codex CLI 压缩实现对比（badlogic gist）、Anthropic 自动压缩 Cookbook、Anthropic context engineering / context editing 文档、WorkOS pi 压缩配置实践、DeepSeek Harness `packages/compaction/*` README 与 `docs/subsystems/compaction.md`。

## 3. 设计

### 3.1 打通配置入口（核心交付）

新增 `compact` 配置段（zcode config JSON），并在 env 适配层支持少量覆盖。**所有默认值与现状完全一致，纯增量、不改默认行为。**

```jsonc
{
  "compact": {
    // 未设置的字段直接省略键（schema 不接受 null）；省略即维持代码内默认行为。
    "enabled": true,                  // 总开关；同时验证/修复 features.compact 未接线问题
    "bufferTokens": 13000,
    "keepRecentRounds": 1,
    // 以下为可选字段示例（按需填写，此处注释说明默认语义）：
    // "contextWindowTokens": 200000,  // 覆盖模型窗口；省略=沿用模型解析结果，仅模型缺失窗口信息时回退 200K 兜底
    // "thresholdRatio": 0.8,          // 比例帽，阈值 = min(窗口×ratio, 窗口−输出预留−buffer)；省略=仅绝对公式
    // "keepRecentTokens": 40000,      // token 预算制保留近期消息；省略=轮次制
    // "outputReserveTokens": 16000,   // 输出预留，只能在 21K 硬上限内下调；省略=统一预算推导
    // "summaryMaxOutputTokens": 20000,
    // "summaryProvider": "...",       // 独立摘要模型，与 summaryModel 必须成对设置
    // "summaryModel": "...",
    // "maxConsecutiveFailures": 3,
    "microcompact": {
      "enabled": false,               // 维持默认关闭（已确认）
      "keepRecentToolResults": 5,
      "idleThresholdMinutes": 60,
      "minTokenSavings": 256
      // "thresholdTokens": null 之类的写法无效：省略=按 autoThreshold×0.9/buffer 推导默认值
    }
  }
}
```

env 覆盖（遵循现有 `ZCODE_*` 模式，仅关键项）：`ZCODE_COMPACT_ENABLED`、`ZCODE_COMPACT_CONTEXT_WINDOW_TOKENS`、`ZCODE_COMPACT_BUFFER_TOKENS`、`ZCODE_COMPACT_THRESHOLD_RATIO`、`ZCODE_COMPACT_KEEP_RECENT_TOKENS`、`ZCODE_MICROCOMPACT_ENABLED`。

接线链路：config schema（adapters zod）→ bootstrap `runtime-config.ts` 构造 `AgentRuntimeConfig.compact` → core policy 层消费（消费逻辑大部分已存在）。

**`contextWindowTokens` 语义（评审修订）**：现有 `autoCompactIfNeeded`（`runtime/methods/compact.ts:193-198`）以 `contextWindow: context.model.properties.contextWindow` 为首选、`...this.config.compact` 展开覆盖。因此配置层**不得**把 200000 作为默认值灌入（否则会覆盖 128K 等模型的真实窗口，改变压缩时机）；默认 `null`（不设置该键），仅当模型缺窗口信息时 policy 层使用 `DEFAULT_COMPACT_CONTEXT_WINDOW=200_000` 兜底，与现状一致。显式配置才覆盖模型窗口。

### 3.2 保留近期消息支持 token 预算制

`keepRecentTokens` 配置时：从最新消息向前累积 token（复用 `estimateRuntimeEntryTokens`），达到预算即切保留段；切割点必须落在合法边界（tool result 与调用附着，复用现有轮组切分逻辑，只调整"保留多少组"的判定从"固定 1 组"变为"按 token 预算决定组数"）。未配置时回退现有"最近 1 轮组"。

### 3.3 thresholdRatio 双帽阈值

`getAutoCompactThreshold` 扩展为 `floor(min(W × thresholdRatio, W − O − B))`（对齐 DeepSeek Harness）。`thresholdRatio=null`（默认）时公式退化为现状，行为不变。设为 `0.8` 等值可在 1M 等大窗口模型上显著提前触发。

### 3.4 配置校验 fail-fast

zod refinement 拒绝非法组合（对齐 DeepSeek Harness 的加载即报错原则，映射到 ZCode 的 zod 体系）：

- `thresholdRatio` ∈ (0, 1)，且 `floor(W × thresholdRatio)` 必须 < `W − O − B`（比例帽必须真正收紧阈值）
- `keepRecentTokens` ≥ 0 且必须显著小于阈值空间
- `keepRecentRounds` ≥ 1
- `summaryMaxOutputTokens` ≤ 模型 max 输出

约束逐字段定义（评审修订，避免一刀切）：比例字段（`thresholdRatio`、`microcompact.thresholdRatio`）为 (0, 1) 内有限小数；token 数与轮数字段为非负整数；可为 `null` 的字段显式列举：`contextWindowTokens`、`thresholdRatio`、`keepRecentTokens`、`summaryModel`、`summaryProvider`。

### 3.5 独立摘要模型

`summaryModel`/`summaryProvider` 配置时，摘要请求（`compact-summary-model-request.ts`）路由到指定模型（对齐 DeepSeek Harness 与 Anthropic Cookbook 的"用便宜模型做摘要"实践）；未配置回退当前模型。需处理独立模型的 contextWindow/maxOutputTokens 解析。

### 3.6 Microcompact 参数可配（默认关闭）

`resolveLocalMicrocompactConfig` 从 config 读取全部字段；默认值不变、默认关闭不变。

### 3.6.1 Microcompact 默认值决策

维持默认关闭（用户已确认）。理由：仓库当初刻意选择默认关闭（`runtime/methods/microcompact.ts:111` 要求显式 `enabled === true`）；开启属行为变更，留给用户显式选择。

## 4. 不做的事（YAGNI）

- `modelPolicies` 按 provider/model 覆盖（DeepSeek 有；等真实需求）
- 指数退避重试（现有固定 3 次 + 熔断已够用）
- 压缩后质量下降 TUI 提示（Codex 做法；UI 层另行立项）
- 默认阈值调整（83% 已在 85–90% 推荐区间附近）
- token 估算从字符估算升级为精确 tokenizer（涉及面大，另行立项）

## 5. 涉及文件

| 文件 | 改动 |
|---|---|
| `apps/zcode-cli/packages/contracts/src/config/index.ts` | config key 与类型 |
| `apps/zcode-cli/packages/adapters/src/config/schema.ts` | zod schema + refinement |
| `apps/zcode-cli/packages/adapters/src/config/index.ts` | 默认值 |
| `apps/zcode-cli/packages/adapters/src/config/env-config.adapter.ts` | env 覆盖 |
| `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts` | 构造 `AgentRuntimeConfig.compact` |
| `apps/zcode-cli/packages/core/src/compact/policy.ts` | thresholdRatio 双帽 |
| `apps/zcode-cli/packages/core/src/runtime/helpers/compact-selection.ts` | keepRecentTokens 预算制 |
| `apps/zcode-cli/packages/core/src/runtime/methods/compact-summary-model-request.ts` | 独立摘要模型路由 |
| `apps/zcode-cli/packages/core/src/runtime/methods/microcompact.ts` | config 接线 |

实施前按仓库规则先更新对应 spec、运行 `pnpm architecture:check --changed`。

## 6. 测试计划

- `compact-policy.test.ts`：thresholdRatio 双帽、null 退化行为、边界值
- `compact-selection` 相关测试：keepRecentTokens 预算切分、回退轮次制、tool result 附着边界
- 新增 config 解析测试：合法/非法组合、env 覆盖优先级、fail-fast 报错信息
- 模型窗口回归场景（评审补充）：未配置 `contextWindowTokens` 时，128K / 200K / 1M 模型窗口的阈值分别跟随模型（94K / 166K / 966K），不被配置默认值覆盖
- 摘要模型路由测试：配置模型路由、未配置回退
- 验证：`pnpm typecheck`、`pnpm lint`、affected 单测（`pnpm verify:pre-push`）

## 7. 风险与兼容性

- 默认值全部不变，存量用户无感；新配置面纯增量。
- `features.compact` 接线疑点：已确认——bootstrap 从未构造 `AgentRuntimeConfig.compact`，本次补齐映射链路，`features.compact` 首次真正生效（作为 `compact.enabled` 的回退默认值）。
- `keepRecentTokens` 预算制改变保留边界的确定性（轮次制→token 制），只在显式配置时启用，回退路径覆盖测试。
- 独立摘要模型引入跨模型能力差异（如不支持媒体）——沿用现有 `compact-media` 降级链路。

## 8. 实现记录（as-built，2026-10-20）

与 §3 原案的三处偏差，均由实施中的既有守卫驱动：

1. **`outputReserveTokens` 落在新的 policy 字段上**。原案复用 `AutoCompactPolicyConfig.maxOutputTokens`，但 `runtime-compact.test.ts` 的回归守卫（"该旧配置值不能覆盖模型级 effective 预算"）固定了 runtime 推导值必须最后覆盖该字段。因此新增独立字段 `outputReserveTokens`，语义为"只在 21K 硬上限内下调输出预留"（`getAutoCompactOutputReserveTokens` 先检查该字段）。
2. **microcompact 暴露 `thresholdTokens`（绝对覆盖）**。原案列出的 `thresholdRatio`/`thresholdBufferTokens` 只是默认值推导常量，`LocalMicrocompactPolicyConfig` 本身的可调项就是 `thresholdTokens`，按既有策略类型暴露。
3. **摘要模型成对校验**以 zod `superRefine` 实现（`summaryProvider`/`summaryModel` 必须同时设置），落在 §3.4 fail-fast 体系内。

实现涉及的存储/合并链路补全：`ConfigStore.merge` 与 `config-merger.ts` 均按层深合并 compact 段（含 microcompact 子对象），`getAll`/`getDefaultValue` 注册 `ConfigKey.Compact`。bootstrap 的 `resolveCompactPolicyConfig` 在映射时剔除值为 undefined 的键——`autoCompactIfNeeded` 以 `{ contextWindow: 模型窗口, ...compact }` 构造策略，显式 undefined 键会把模型窗口覆盖回 200K 兜底。

### 8.1 codex 复审修复（2026-10-20 第二轮）

实施后 codex 评审（gpt-6.1-sol / xhigh）发现 3 项 P2 + 1 项 P3，已全部修复：

1. **P2 激进保留使压缩退化成 no-op**：`keepRecentRounds`/`keepRecentTokens` 过大时保留段可达 `groups−1`，摘要区只剩首个 user 组、不满足压缩条件 → 超窗会话无法恢复。修复：新增 `maxConfiguredPreservableGroups` 封顶（摘要区保底 ≥2 组且含 assistant；只钳制配置旋钮，不影响 prompt-too-long 重选增长）。
2. **P2 Reactive 超窗重选丢失保留下限**：`selectInitialCompactEntriesForActiveConversation` 在有 overflow cause 时优先返回不带 `preserveRecent` 的重选结果。修复：`selectCompactEntriesForInitialPromptTooLong` 接受并透传 `preserveRecent`，重选结果以配置下限为底、按 token gap 增长。
3. **P2 独立摘要模型 × native ToolSearch 抛错**：会话 native mode 是主模型契约，摘要模型来自其他 provider 时 `resolveToolSearchMode` 在请求构造前抛错。修复：`coerceToolSearchModeForModel`（compact-active-helpers）按摘要模型能力把 native/local 降级为 auto；`prepareRuntimeProviderRequest` 新增 `toolSearchMode` 覆盖参数，compact 请求两处消费点均使用。注：该助手未放进 `tool/search/exposure.ts`——该目录非受管模块且文件为规则生效后新增，任何改动触发 `unmanaged-new-file`；为避免为单个助手 adopt 整个模块，落在已受管的 runtime 层。
4. **P3 文档示例 null 值过不了 schema**：示例改为"未设置即省略键"，可选字段以注释说明。

`enabled` 语义（产品决定）：`compact.enabled=false` 关闭 Auto/Reactive/Micro 三条自动链路；手动 `/compact` 保持可用（显式用户命令不受自动开关影响）。

改动文件：`contracts/src/config/index.ts`、`adapters/src/config/{schema,index,config-merger,env-config.adapter}.ts`、`core/src/compact/policy.ts`、`core/src/runtime/helpers/{compact-selection,compact}.ts`、`core/src/runtime/methods/compact-active.ts`、`bootstrap/src/app/runtime-config.ts`，测试四件（`compact-policy`、`runtime-compact`、`adapters config`、`bootstrap runtime-config`）。
