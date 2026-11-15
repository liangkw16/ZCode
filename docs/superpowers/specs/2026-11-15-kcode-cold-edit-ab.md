# 冷恢复首次编辑优化与真实模型 A/B

## 设计与验收

根因证据来自上一轮四次真实冷恢复：文件正文由 compact 附件恢复，首次 Edit 却都报未读取。源码合同明确补回读取状态只在内存；本批将完整补回的结构化快照随正文 text part 保存，再从 active 的可信 runtime 附件恢复。唯一状态所有者仍为 Runtime 的共享 `readFileState`；不在恢复时读磁盘认证新内容，不修改 Read/Edit/Write freshness、权限或 UI/V4 协议。

选择这一方案，是因为已有正文和真实读取证据足够完成恢复。仅加提示词提醒仍会产生重复 Read；在首次 Edit 中自动读取当前磁盘并放行会把模型未见过的内容当成已读。部分引用、截断、旧记录、缺少 freshness 字段和非可信附件仍不得直接编辑。事件顺序与持久化合同见 [Read File State Resume](../../../apps/zcode-cli/docs/design/v2/tool/17-read-file-state-resume.md) 及 [Rewind & Compact](../../../apps/zcode-cli/docs/design/v2/rewind-compact.md)。

回归先确认冷恢复读取状态为 0，再覆盖完整快照恢复、首次 Edit 成功、原有 stale 检查拒绝外部修改、可信来源与字段校验、active boundary、后续工具覆盖、部分引用不保存快照。现有 mtime / 大小优先及同内容容差保持；同 mtime 同大小变化的既有容差不在本批调整。

## 本轮 A/B 协议

A 为本批代码改动前 `38c40890`，B 为本批修复提交。复用[上一轮协议](2026-11-15-kcode-real-model-ab.md)、同一 `codex/gpt-6.1-sol` / medium、三个 fixture、相同预算和外部断言。每场景两对，共 12 次任务；第一轮 B→A，第二轮 A→B。独立编译两版 Core，其他包保持一致，实验产物使用新目录，不复用上一轮结果或以重跑替换样本。

先比较任务验收与主动验证，再比较首次 Edit 的未读拒绝、冷恢复后的 Read、总请求、工具数、wire usage 和耗时。压缩场景仍是真实 `/compact` → 关闭 App → 冷恢复原 session → 原样“按刚才方案继续完成”。不提示模型避开首次 Edit，不改变任务输入以迎合修复。

## 结果

待执行。产物目录：`.tmp/kcode-cold-edit-ab-20261115/`。
