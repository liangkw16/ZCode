# Compact Model Overrides 设计（`compact.modelOverrides`）

## 文档定位

本文是 [README.md](./README.md)（compact 总设计）的补充篇，记录按模型覆盖 compact 阈值策略的领域边界、配置契约、合并语义、解析所有权与验收标准。属于 `L1 Candidate Contract`：固定语义与规则，不固定最终 TypeScript 接口细节。

状态：设计已与 owner 对齐（2026-10-22），并经独立评审修订（2026-10-22，子代理继承与程序化共存两项契约为评审后按最小影响面选定，owner 可推翻）。待实现。实施拆分见 [model-overrides-plan.md](./model-overrides-plan.md)。

## 背景与动机

当前 `compact` 配置是全局唯一段。主 runtime 策略组装处（`runtime/methods/compact.ts` 组装 `AutoCompactPolicyConfig` 时）先放模型自身窗口，再展开 `...config.compact`，因此全局 `compact.contextWindowTokens` 会覆盖**主 runtime 内所有模型**的窗口：主会话把模型切到 200K 窗口模型时，全局 400K 会让阈值高于自身真实窗口，主动压缩失效，退化为 reactive（provider 报超窗后补救，每个 model step 仅一次恢复机会）。

另一项关键现状：**子代理 runtime 不接收任何 compact 配置**（`runtime/methods/subagent.ts` 构造 child 时不传 `compact` 字段），始终按默认策略压缩（阈值 = 子代理模型窗口 − 34K，如 128K → 94K）。因此：

- 大窗口模型想收紧（GLM-5.3 / GLM-5.3-Flash 1M 窗口想按 400K 策略压缩，对齐官方评测口径）——需要主 runtime 按模型表达；
- 按模型覆盖**子代理**压缩阈值——是新能力（当前子代理无配置入口），不是修复既有误伤。

生态先例（2026-10 调研）：Droid 提供 `compactionTokenLimitPerModel: {<modelId>: number}`；Claude Code 提供 `modelSettings.<model>.autoCompactWindow`（含 `"auto"` 语义）；OpenAI Codex CLI 的模型元数据自带 `auto_compact_token_limit`（按模型不同默认值）。"窗口事实来自模型元数据 + 全局阈值兜底 + 按模型例外"是主流形态。

### 决策记录（已与 owner 对齐；最后两行为评审后修订）

| 决策点 | 结论 |
| --- | --- |
| V1 覆盖字段范围 | 白名单 4 字段：`contextWindowTokens` / `thresholdRatio` / `bufferTokens` / `outputReserveTokens` |
| 产品默认策略 | 只交机制，默认行为不变（不配置 `modelOverrides` 与现状完全一致） |
| 实现位置 | policy 层纯函数 `applyCompactModelOverrides`，每次压缩判定时解析（否决"启动时烘焙"与"注入 Model.properties"） |
| 匹配语义 | `providerId + modelId` 精确匹配，大小写敏感，无通配 |
| `"auto"` 语义 | V1 不做（省略字段 = 继承全局；删除全局值即回到模型窗口） |
| env 入口 | V1 不提供（仅 config.json 层） |
| 子代理继承 | **child runtime 只接收 `modelOverrides` 覆盖表**，不接收全局阈值字段；未配置时 child 的 compact 配置保持不存在（与现状一致） |
| 程序化共存 | **程序化 runtimeOverride 存在时忽略 `modelOverrides`**（bootstrap 剔除 + warn 日志）：程序化策略是嵌入方对压缩行为的整体接管，文件级按模型例外不与其混用 |

## 目标与非目标

**目标**：同一 Runtime 内，不同模型各自按专属阈值触发 Micro/Auto 压缩；子代理能通过覆盖表获得按模型策略；阈值策略可按模型表达且不引入第二份窗口事实。

**非目标**（防止捆绑，逐项显式排除）：

- 修复 `compact.summaryProvider/summaryModel` 的 reasoning-level 缺陷（另案；Droid 的 `compactionModel`（默认 `same`）可作修复时的语义参考）。
- `"auto"` 语义、通配匹配、显示名匹配。
- reactive 路径、摘要链路、UI/desktop 改动（`CompactRuntimeConfig` 仅 CLI 内部消费，已核实无跨包消费方）。
- 调整产品默认阈值（如全局默认 ratio）；等 304K vs 760K 对照数据后再议。
- 子代理继承全局阈值字段（维持"子代理不接收全局 compact 配置"的现状；需要给子代理配阈值时通过覆盖表按其 modelId 表达）。

## 契约

### Schema

```ts
export interface CompactModelOverride {
  contextWindowTokens?: number;   // 正整数
  thresholdRatio?: number;        // (0,1) 开区间
  bufferTokens?: number;          // 正整数
  outputReserveTokens?: number;   // 正整数；21K 上限由 policy 层 min-cap 生效，schema 不重复校验（与全局段一致）
}

// CompactRuntimeConfig 追加：
modelOverrides?: Record<
  string, // providerId
  Record<string, CompactModelOverride> // modelId
>;
```

校验规则（`adapters/src/config/schema.ts`，strict）：

- 未知字段拒绝；`providerId` / `modelId` 空串拒绝；嵌套未知字段拒绝；数值为零、负数、小数、字符串均拒绝。
- 空 override 对象（`{ p: { m: {} } }`）与空表是合法 no-op，**不会清除低层已声明的条目**；删除某模型的覆盖须在声明它的配置层修改。
- 违规走现有配置整体拒绝路径。

示例（推荐配置，键为 Registry 真实 ID，大小写敏感）：

```json
{
  "compact": {
    "thresholdRatio": 0.76,
    "modelOverrides": {
      "account:bigmodel-individual-coding-plan": {
        "GLM-5.3": { "contextWindowTokens": 400000 },
        "GLM-5.3-Flash": { "contextWindowTokens": 400000 }
      }
    }
  }
}
```

### 合并语义

配置层沿用现有合并链（System → User → Project → Session → Env → CLI）。`modelOverrides` 按 **provider → model → 字段** 三层逐级合并，不做整表替换：项目层只改一个模型的一个字段时，其余 provider / model / 字段保留低优先级层的值；显式 `undefined` 值不覆盖低层已配置值。合并 helper 需同时服务于两条合并入口（`config-merger.ts` 启动合并与 `adapters/src/config/index.ts` ConfigStore 增量 merge），不得修改输入对象。

### 解析时机与所有权

```text
配置合并（含 modelOverrides 逐层合并）
        │
        ▼
每次模型 step 前（turn-loop，Micro → Auto 顺序不变）
        │
        ├── microcompactIfNeeded ─┐
        │                         ├─ 共用 applyCompactModelOverrides(config.compact, context.model)
        └── autoCompactIfNeeded ──┘     = modelOverrides[providerId][modelId] 的白名单字段
                                          覆盖全局值；未设置字段剔除、不覆盖；
                                          结果剥离 modelOverrides 键
        │
        ▼
getAutoCompactThreshold（公式不变：
  min(窗口 − min(显式 outputReserveTokens（仅可下调）或 maxOutputTokens, 21K) − buffer, floor(窗口 × ratio))）
        │
   未达阈值 → 发请求；provider 超窗 → Reactive 兜底（每 step 一次，语义不变）
```

规则：

- `applyCompactModelOverrides` 为纯函数，落在 `core/src/compact/policy.ts`；每次压缩判定时用**实际执行模型**解析。不查 Registry、不写日志、不修改 `Model.properties`、不缓存窗口事实。
- 返回 `{ config, source, matched }`：`matched` = 覆盖表中存在该 providerId+modelId 条目（含空对象）；`source` = 应用至少一个字段后为 `"model-override"`，否则 `"global"`（含"有条目但字段全空"）。
- 子代理：父 runtime 构造 child 时**只透传未解析的 `modelOverrides` 表**（`compact: { modelOverrides }`；未配置时不传 compact 键）；child 用自己的 Active Model 解析，父代理解析结果不得传给 child。
- 优先级：**程序化 runtimeOverride（存在时整体接管，忽略 modelOverrides）> modelOverrides > 全局 `compact` > 模型窗口与 policy 默认常量**。bootstrap `resolveCompactPolicyConfig` 检测到程序化 override 时剔除 `modelOverrides` 并输出 warn。
- 日志：auto/micro 既有判定日志统一增加 `policySource`、`modelOverrideMatched`、`providerId`、`modelId`、有效窗口与阈值（复用 trace context；micro 路径不丢弃 source）。未命中 = 当前执行模型查表失败，debug 级可见，不刷屏。

### 生效数值示例

假设模型 maxOutputTokens ≥ 21K、默认 buffer 13K（`W` = 生效窗口，override 未设字段继承全局）。micro 默认压力阈值联动公式：`M(T) = max(0, min(⌊T×0.9⌋, T−2000))`（T 为最终 auto 阈值；T ≤ 2000 时为 0）。

| 场景 | 全局配置 | override | Auto 触发阈值 | Micro 默认阈值 |
| --- | --- | --- | --- | --- |
| GLM-5.3 主代理（1M） | `thresholdRatio: 0.76` | `contextWindowTokens: 400000` | min(366K, 304K) = **304K** | **273.6K** |
| GLM-5.3-Flash 长跑（1M） | `thresholdRatio: 0.76` | （删除该 override 即实验 760K） | min(966K, 760K) = **760K** | **684K** |
| 其他 GLM-5（200K） | `thresholdRatio: 0.76` | 无 | min(166K, 152K) = **152K** | **136.8K** |
| 128K 子代理模型 | 无 | 无 | **94K**（默认策略，不变） | **84.6K** |
| 128K 子代理模型 | 无 | `{ contextWindowTokens: 100000 }`（经父透传） | **66K** | **59.4K** |

注：ratio 咬合点为 `0.76·W ≤ W − 34K`，即 `W ≥ 141,667`；窗口小于该值时绝对阈值主导（如 128K 得 94K 而非 97,280）。

### 失败与诊断

- 未匹配的合法条目：保留不报错（供后续安装/启用的模型生效），判定日志以 `modelOverrideMatched: false` 呈现（debug 级）。
- schema 违规：现有 strict 拒绝路径，配置整体不生效。
- 程序化 override 与 modelOverrides 并用：忽略后者并 warn（程序化策略整体接管）。
- resolver 只做字段挑选，无任何静默修正或运行时兜底分支。

### 兼容性

- 不配置 `modelOverrides`：主 runtime 与子代理行为与当前完全一致（子代理继续无 compact 配置）。
- 全局 `compact.contextWindowTokens` 语义不变（仍覆盖主 runtime 内所有模型），文档需明确 `modelOverrides` 优先于它。
- 纯 CLI 内部契约增量，无跨包影响、无持久化格式变化、无迁移。

## 测试验收

1. **schema**：非法字段 / 非法数值（零、负、小数、字符串）/ ratio 边界（0、1 拒绝）/ 空 key / 嵌套未知字段拒绝；合法样例与空对象条目通过。
2. **merger**：跨层只改一个 model 的一个字段时，其他 model / 字段保留；同字段高优先层覆盖；与 `microcompact` 子对象同时存在互不干扰；ConfigStore 增量 merge 连续两次不丢条目；合并不修改输入对象。
3. **policy**：数值表各 Auto 阈值（304K / 760K / 152K / 94K / 66K）；阈值边界（T−1 不触发、等于 T 触发）；显式 `outputReserveTokens` 下调组合；provider 不同而 modelId 相同不串；空对象条目（matched true、source global）；结果剥离 `modelOverrides` 键。
4. **runtime + 子代理**：同一 Runtime 切模型得到各自阈值（组装点断言）；micro 默认阈值跟随解析后阈值；child 只接收 `modelOverrides`（未配置时 child compact 不存在）；父阈值不受 child override 影响；未知 modelId 回退；无 compact 配置旧行为回归。
5. **并行集成场景**：1M 父代理（override 400K，日志报 304K）与 128K 子代理（无 override，日志报 94K）并行，子代理在达到自身窗口前主动压缩。

## 风险与开放问题

- 304K 与 760K 哪个质量更优无对照数据；机制上线后应固定任务集对比（成功率、重复工作、总输入、Reactive 次数）。
- 未匹配条目长期堆积属配置卫生问题，V1 只做 debug 日志不做告警。
- 程序化 override + modelOverrides 并用在 V1 被定义为"忽略后者"；若未来出现真实共存需求，需把程序化覆盖拆成独立传递链（组装点顺序：文件+全局 → modelOverrides → 程序化）。
- 全局 `contextWindowTokens` 旧语义保留会造成"全局窗口覆盖 + 按模型例外"的双层心智，文档必须写清优先级；是否给旧字段加"不超过真实模型窗口"的安全帽，留待对照数据后单独立项。
- 后续演进候选（均不在 V1）：`contextWindowTokens: "auto"`（显式清除全局继承）、`summaryProvider/summaryModel` 修复（对齐 Droid `compactionModel` 语义）、按模型 `enabled`、子代理继承全局阈值字段。

## 涉及文件

- `apps/zcode-cli/packages/contracts/src/config/index.ts`：类型增量。
- `apps/zcode-cli/packages/adapters/src/config/schema.ts`：严格校验。
- `apps/zcode-cli/packages/adapters/src/config/config-merger.ts`：覆盖表三层合并（helper 共用）。
- `apps/zcode-cli/packages/adapters/src/config/index.ts`：ConfigStore 增量 merge 复用同一 helper。
- `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts`：透传 + 程序化共存剔除。
- `apps/zcode-cli/packages/core/src/compact/policy.ts`：`applyCompactModelOverrides` 纯函数。
- `apps/zcode-cli/packages/core/src/runtime/methods/compact.ts`、`microcompact.ts`：组装点接入。
- `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`：child 只透传 `modelOverrides`。
