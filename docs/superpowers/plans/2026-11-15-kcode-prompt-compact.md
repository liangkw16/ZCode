# KCode Prompt and Compact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 精修提示词并修复压缩接续、摘要截断、提交一致性及 microcompact 时间精度。

**Architecture:** 继续由 CLI Runtime 拥有活动上下文，SessionStore 保存压缩事实。分离摘要模型与接续模型，提交前准备候选状态，提交成功后先安装状态再发布事件。

**Tech Stack:** TypeScript、Node 24.14.0、pnpm 10.33.2、Vitest、SQLite。

**Spec:** `docs/superpowers/specs/2026-11-15-kcode-prompt-refinement-design.md`

## Global Constraints

- 用户已要求 native 开工，本计划由当前会话执行，不再增加计划确认门槛。
- 不新增依赖、配置、数据库表或 App 业务单测；CLI 回归走现有 package 入口。
- 权限、阶段边界、工具批次和原文保留段继续生效；旧安全段已删除，不再注入。
- Bugfix 留中文原因注释；所有验证报告真实错误与告警。
- 各步骤先更新相关 CLI spec，再补失败回归，再实现。

## Review Focus

- 提交后事件部分成功：复用 event ID/sequence 补投，不能重复摘要或 operation（Task 4）。
- 独立摘要模型能力不同：接续 MCS/ToolSearch、Plan 与 snapshot 使用实际主模型（Task 3）。
- 截断与 PTL/网络恢复混合：输出恢复预算属于 operation，不因重试清零（Task 2）。
- 提交后取消、TurnComplete/usage/projection 失败：压缩保持 completed，外层轮次真实结束（Task 4）。
- 冷恢复 failed/interrupted timeline 与成功 boundary：同 operation 校正，真实失败保持原状（Task 4）。

---

### Task 1: Prompt ownership

**Files:** Modify `core/src/context/sections/{identity,instruction-files,workflow-actor}.ts`、`core/src/context/dynamic-sections.ts`；对应 CLI `loop/system-prompt-contract.md`、`loop/meta-user-context.md`。
**Interfaces:** 保持 `buildIdentitySection` 与 builder 公开入口；共享 Harness 只含共同规则，Main 自带默认呈现。

- [x] 更新 CLI 合同，修改 `context-builder.test.ts` 的来源/呈现断言，先运行确认失败。
- [x] 删除无界 OVERRIDE 前言、移出共享呈现断言，合并重复行为句并保留完成条件。
- [x] Run `mise exec -- pnpm --dir apps/zcode-cli/packages/core exec vitest run tests/context-builder.test.ts tests/runtime-context-announcements.test.ts tests/prompt-snapshot.test.ts`。Expected: PASS。
- [x] Commit `feat(kcode): clarify prompt ownership and task execution`。

### Task 2: Summary output recovery and microcompact time

**Files:** Modify `core/src/runtime/methods/compact-active{,-helpers}.ts`、`core/src/compact/microcompact.ts`；`runtime-compact.test.ts`、`microcompact.test.ts`；CLI compact specs。
**Interfaces:** 复用 `isOutputTokenLimitFinishReason`；同 operation 最多一次短摘要重新生成，耗尽为不可原样重试错误。

- [x] 更新 spec，补非空/空 length、raw 上限、恢复耗尽与 0.5/1.5 分钟失败回归。
- [x] 先运行新回归确认失败，再实现输出恢复优先于输入超窗；保持输入、cap、自定义指令，拒绝提交 partial。
- [x] idle 使用有限非负数原值，其他整数 helper 不变。
- [x] Run `mise exec -- pnpm --dir apps/zcode-cli/packages/core exec vitest run tests/runtime-compact.test.ts tests/microcompact.test.ts tests/compact-policy.test.ts tests/compact-summary-model-request.test.ts`。Expected: PASS。
- [x] Commit `fix(cli): preserve complete compact summaries and fractional idle time`。

### Task 3: Continuation model

**Files:** Modify `compact-active.ts`、既有 context helper；`prompt-snapshot.test.ts`、ToolSearch 相关测试；CLI compact/snapshot specs。
**Interfaces:** `options.model` = continuation model；独立 summary selection 仅影响摘要请求。新 system 在局部候选中生成，提交前不改变 live。

- [x] 补主/摘要 MCS 不同、native ToolSearch 与非 native summary、truePost 最终前缀的失败回归。
- [x] 分配两类模型及工具来源，保留 execution/fallback/offpeak Model 对象；使用最终接续前缀统计。
- [x] Run `mise exec -- pnpm --dir apps/zcode-cli/packages/core exec vitest run tests/prompt-snapshot.test.ts tests/runtime-context-announcements.test.ts tests/tool-search-announcement-runtime.test.ts tests/compact-preserved-inputs.test.ts`。Expected: PASS。
- [x] Commit `fix(cli): bind compact restoration to the continuation model`。

### Task 4: Commit boundary and publication

**Files:** Modify `compact-persistence.ts`、`timeline-persistence.ts`、`events.ts`、`compact-active.ts`、`compact.ts` 与内部方法类型；既有 core/SQLite 回归。
**Interfaces:** 现有 `commitMessageBundle` 保存 completed timeline；返回已提交 entries 与独立同步错误供外层安装后停止。通用 append 不新增重复语义。

- [x] 更新 spec/事件链，移植故障注入：提交后 boundary event 失败、partial append、连续失败、旧 failed/interrupted 恢复、取消及外层完成失败，先确认失败。
- [x] 提取既有 timeline record 构建供单写与 bundle 共用，completed 与 summary 原子保存；legacy store 只补偿新 records。
- [x] 提交后同步安装 live/read-state/instruction context 并失效内存 snapshot；快照 tombstone 独立 warning 合同保留。
- [x] 发布 boundary/completed 各一次有界幂等补投，持续失败将 committed entries 交给调用者后终止 turn；不重压、不计 compact failure。
- [x] 扩展 boundary 驱动的冷恢复，补齐 manual 提交后轮次收尾。
- [x] Run core `runtime-compact.test.ts`、`compact-persistence-selection.test.ts`、`prompt-snapshot.test.ts` 和新增故障回归；adapter SQLite bundle 测试。Expected: PASS。
- [x] Commit `fix(cli): make compact completion follow the committed boundary`。

### Task 5: Verification and final review

**Files:** 更新 spec/plan 状态与真实验证结果。
**Interfaces:** 使用现有 CLI/provider 与 Desktop continuous/mobile replayable 回放入口验证。

- [x] 运行相关 core 回归及现有脚本化 provider 接续验证，检查成功 boundary 与冷恢复一致。
- [x] Run 根与 CLI `typecheck`、`lint`，`architecture:check --changed` 及修改文件格式检查。Expected: 无新增失败，已有失败分别报告。
- [x] 用 codex-review 对本轮提交范围做一次 fresh review（gpt-6-astra/xhigh），逐项核实；重要发现补失败回归后修复。
- [x] 记录必要偏离、验证限制及未闭合 snapshot 崩溃窗口，完成提交。

## Execution record

Native implementation completed on the existing kcode branch. Tasks 2 and 3 share the compact pipeline and were committed together. The final independent review found two P2 issues; both received RED→GREEN runtime regressions and a single fix pass. Package-manager checks used the pinned pnpm 10.33.2 JavaScript entry where the standalone binary could not serve as npm_execpath. The follow-up below closes the two scripted failures and completes the full cold-resume run; remaining validation limits are recorded in the spec.

### Follow-up: complete scripted E2E and cold resume

- [x] 两个 scripted case 原样复现失败；检查所有 `createApp` 调用与通知投影合同。
- [x] 单独完整运行 `v4-cold-resume.test.ts --maxWorkers=1 --reporter=verbose`：124/124 通过；此前 SIGTERM 原因未复现，不据此修改 runtime。
- [x] 修复 usage-anchor 三处漏等异步 App 创建，补全 background-bash 的完整 provenance 文本断言。
- [x] 全部 7 个 scripted case 通过；App helper 4/4 通过；根与 CLI typecheck/lint 通过（告警与前批一致），格式与架构检查通过。完成验证记录并提交。

### Follow-up: real-model A/B

- [x] 固定三场景、每场景两对的协议；独立编译 A=`0549bd90` 与 B=`8586658a` 的 Core，使用同一真实模型与受控配置执行全部 12 次任务。
- [x] 两组均为任务 6/6、断言 54/54、主动验证 6/6；B 的总耗时与逻辑输入略增，未确认整体效率收益。四次冷恢复均观察到首次 Edit 被拒后的定向重读。
- [x] 保存原始轨迹、外部验收和重算指标；完成[真实模型 A/B 报告](../specs/2026-11-15-kcode-real-model-ab.md)，同步既有验证记录。

### Follow-up: compact file freshness after cold resume

- [x] 先更新 CLI spec 并复现冷恢复丢失读取状态；在完整正文所属 text part 保存既有结构化快照，从 active 的可信附件恢复，保留原有 Read/Edit/Write guard。
- [x] 修复提交 `3624b0e5`；Core 5,088 通过、21 跳过，完整冷恢复 124/124，scripted E2E 7/7，根与 CLI 门禁通过。
- [x] 新一轮同模型、同任务 12 次真实运行全部通过；冷恢复首次 Edit 由 0/2 成功到 2/2，接续请求合计 12→8、显式 Read 4→0。详见[专项报告](../specs/2026-11-15-kcode-cold-edit-ab.md)。
- [x] 从原始 JSON + SSE 补齐摘要 usage，并逐样本核对 runtime；同步修正上一轮报告的 token 数值，保留所有原始样本。
