# Compact Model Overrides 设计（`compact.modelOverrides`）

## 文档定位

本文是 [README.md](./README.md)（compact 总设计）的补充篇，记录按模型覆盖 compact 阈值策略的领域边界、配置契约、合并语义、解析所有权与验收标准。属于 `L1 Candidate Contract`：固定语义与规则，不固定最终 TypeScript 接口细节。

状态：设计已与 owner 对齐（2026-10-22），待实现。实施拆分见后续 plan 增补。

## 背景与动机

当前 `compact` 配置是全局唯一段。策略组装处（`runtime/methods/compact.ts` 组装 `AutoCompactPolicyConfig` 时）先放模型自身窗口，再展开 `...config.compact`，因此全局 `compact.contextWindowTokens` 会**无差别覆盖所有会话的模型窗口**：主代理、子代理、任何模型共用同一份阈值。

由此产生的两类实际问题：

1. **大窗口模型想收紧**：GLM-5.3 / GLM-5.3-Flash（1M 窗口）希望按 400K 策略压缩（对齐官方评测口径），但全局设 400K 会波及所有模型。
2. **小窗口模型被误伤**：全局 400K 覆盖使 200K / 128K 模型的阈值高于自身真实窗口，主动压缩永不触发，退化为 reactive（provider 报超窗后补救，每个 model step 仅一次恢复机会）。

生态先例（2026-10 调研）：Droid 提供 `compactionTokenLimitPerModel: {<modelId>: number}`；Claude Code 提供 `modelSettings.<model>.autoCompactWindow`（含 `"auto"` 语义）；OpenAI Codex CLI 的模型元数据自带 `auto_compact_token_limit`（按模型不同默认值）。"窗口事实来自模型元数据 + 全局阈值兜底 + 按模型例外"是主流形态。

### 决策记录（已与 owner 对齐）

| 决策点 | 结论 |
| --- | --- |
| V1 覆盖字段范围 | 白名单 4 字段：`contextWindowTokens` / `thresholdRatio` / `bufferTokens` / `outputReserveTokens` |
| 产品默认策略 | 只交机制，默认行为不变（不配置 `modelOverrides` 与现状完全一致） |
| 实现位置 | policy 层纯函数 resolver，每次压缩判定时解析（否决"启动时烘焙"与"注入 Model.properties"） |
| 匹配语义 | `providerId + modelId` 精确匹配，大小写敏感，无通配 |
| `"auto"` 语义 | V1 不做（省略字段 = 继承全局；删除全局值即回到模型窗口） |
| env 入口 | V1 不提供（仅 config.json 层） |

## 目标与非目标

**目标**：同一 Runtime 内，不同模型（主代理、flash 子代理、128K 子代理）各自按专属阈值触发 Micro/Auto 压缩；阈值策略可按模型表达且不引入第二份窗口事实。

**非目标**（防止捆绑，逐项显式排除）：

- 修复 `compact.summaryProvider/summaryModel` 的 reasoning-level 缺陷（另案；Droid 的 `compactionModel`（默认 `same`）可作修复时的语义参考）。
- `"auto"` 语义、通配匹配、显示名匹配。
- reactive 路径、摘要链路、UI/desktop 改动（`CompactRuntimeConfig` 仅 CLI 内部消费，已核实无跨包消费方）。
- 调整产品默认阈值（如全局默认 ratio）；等 304K vs 760K 对照数据后再议。

## 契约

### Schema

```ts
export interface CompactModelOverride {
  contextWindowTokens?: number;   // 正整数
  thresholdRatio?: number;        // (0,1) 开区间
  bufferTokens?: number;          // 正整数
  outputReserveTokens?: number;   // 正整数，≤21K（沿用全局段硬上限校验）
}

// CompactRuntimeConfig 追加：
modelOverrides?: Record<
  string, // providerId
  Record<string, CompactModelOverride> // modelId
>;
```

校验规则（`adapters/src/config/schema.ts`，strict）：

- 未知字段拒绝；`providerId` / `modelId` 空串拒绝；嵌套未知字段拒绝。
- 数值规则与全局段完全一致：`contextWindowTokens` / `bufferTokens` / `outputReserveTokens` 正整数，`outputReserveTokens` ≤ 21000，`thresholdRatio` ∈ (0,1)。
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

配置层沿用现有合并链（System → User → Project → Session → Env → CLI）。`modelOverrides` 按 **provider → model → 字段** 三层逐级合并，不做整表替换：项目层只改一个模型的一个字段时，其余 provider / model / 字段保留低优先级层的值。

实现上与 `config-merger.ts` 中 microcompact 子对象的合并同模式（浅覆盖会丢字段，已有注释先例），并加同款中文注释说明原因。

### 解析时机与所有权

```text
配置合并（含 modelOverrides 逐层合并）
        │
        ▼
每次模型 step 前（turn-loop，Micro → Auto 顺序不变）
        │
        ├── microcompactIfNeeded ─┐
        │                         ├─ 共用 resolveCompactPolicyConfig(config.compact, context.model)
        └── autoCompactIfNeeded ──┘     = modelOverrides[providerId][modelId] 的白名单字段
                                          覆盖全局值；undefined 字段剔除、不覆盖
        │
        ▼
getAutoCompactThreshold（公式不变：min(窗口 − min(maxOut,21K) − buffer, floor(窗口 × ratio))）
        │
   未达阈值 → 发请求；provider 超窗 → Reactive 兜底（每 step 一次，语义不变）
```

规则：

- resolver 为纯函数，落在 `core/src/compact/policy.ts`；每次压缩判定时用**实际执行模型**解析。子代理用自己的 `context.model` 调同一 resolver，不复用父代理的解析结果（测试钉住）。
- 窗口事实的唯一所有者仍是模型元数据（Registry / Active Model）。override 只是策略输入，**不写回 `Model.properties`**，不缓存第二份窗口事实。
- 优先级：显式程序化 runtime override > `modelOverrides` > 全局 `compact` > 模型窗口与 policy 默认常量。
- 日志对齐现有 `compact.summary_model_override` 风格：压缩判定日志记录阈值生效来源（`model-override` / `global` / `model-default`）。

### 生效数值示例

假设模型 maxOutputTokens ≥ 21K、默认 buffer 13K（`W` = 生效窗口，override 未设字段继承全局）：

| 场景 | 全局配置 | override | 触发阈值 |
| --- | --- | --- | --- |
| GLM-5.3 主代理（1M） | `thresholdRatio: 0.76` | `contextWindowTokens: 400000` | min(366K, 304K) = **304K** |
| GLM-5.3-Flash 长跑（1M） | `thresholdRatio: 0.76` | （删除该 override 即实验 760K） | min(966K, 760K) = **760K** |
| 其他 GLM-5（200K） | `thresholdRatio: 0.76` | 无 | min(166K, 152K) = **152K** |
| 128K 子代理模型 | 无 | 无 | **94K**（恢复默认行为） |

注：ratio 咬合点为 `0.76·W ≤ W − 34K`，即 `W ≥ 141,667`；窗口小于该值时绝对阈值主导（如 128K 得 94K 而非 97,280）。microcompact 默认压力阈值联动为最终阈值 × 0.9。

### 失败与诊断

- 未匹配的合法条目：保留不报错（供后续安装/启用的模型生效），判定时打 debug 级未命中日志（避免刷屏）。
- schema 违规：现有 strict 拒绝路径，配置整体不生效。
- resolver 只做字段挑选，无任何静默修正或运行时兜底分支。

### 兼容性

- 不配置 `modelOverrides`：行为与当前完全一致。
- 全局 `compact.contextWindowTokens` 语义不变（仍是"无差别覆盖"），文档需明确 `modelOverrides` 优先于它。
- 纯 CLI 内部契约增量，无跨包影响、无持久化格式变化、无迁移。

## 测试验收

1. **schema**：非法字段 / 非法数值 / ratio 边界（0、1 拒绝）/ 空 key / 嵌套未知字段拒绝；合法样例通过。
2. **merger**：跨层只改一个 model 的一个字段时，其他 model / 字段保留；`modelOverrides` 与 `microcompact` 不被浅覆盖吞掉。
3. **policy**：上表四行数值；阈值边界（阈值 −1 不触发、等于阈值触发）；显式 `outputReserveTokens` 下调组合。
4. **runtime**：同一 Runtime 切模型得到各自阈值；父子代理不同模型各自解析；未知 modelId 回退全局；无 compact 配置旧行为回归。
5. **集成场景**：1M 主代理（override 400K，日志报 304K）与 128K 子代理（无 override，日志报 94K）并行，子代理在达到自身窗口前主动压缩。

## 风险与开放问题

- 304K 与 760K 哪个质量更优无对照数据；机制上线后应固定任务集对比（成功率、重复工作、总输入、Reactive 次数）。
- 未匹配条目长期堆积属配置卫生问题，V1 只做 debug 日志不做告警。
- 全局 `contextWindowTokens` 旧语义保留会造成"全局窗口覆盖 + 按模型例外"的双层心智，文档必须写清优先级；是否给旧字段加"不超过真实模型窗口"的安全帽，留待对照数据后单独立项。
- 后续演进候选（均不在 V1）：`contextWindowTokens: "auto"`（显式清除全局继承）、`summaryProvider/summaryModel` 修复（对齐 Droid `compactionModel` 语义）、按模型 `enabled`。

## 涉及文件

- `apps/zcode-cli/packages/contracts/src/config/index.ts`：类型增量。
- `apps/zcode-cli/packages/adapters/src/config/schema.ts`：严格校验。
- `apps/zcode-cli/packages/adapters/src/config/config-merger.ts`：覆盖表三层合并。
- `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts`：透传。
- `apps/zcode-cli/packages/core/src/compact/policy.ts`：resolver 纯函数。
- `apps/zcode-cli/packages/core/src/runtime/methods/compact.ts`：组装点接入（Micro 路径共用）。
- 对应测试：`adapters/tests/config.test.ts`、core compact policy / runtime-compact / subagent 测试。
