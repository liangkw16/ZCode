# EnterPlanMode / ExitPlanMode

2026-11-15 修订状态：提示词触发与能力感知提醒已实现；权限说明与现有
[Plan 审批边界](../../../../../../docs/plan-mode-approval-boundary.md) 对齐，不新增审批。

## 目标

提供 plan mode provider tools，在用户要求只读讨论或先审方案再实施，或存在无法从请求、源码和合理默认值消解的关键方案决策时进入计划模式；完成只读探索后向用户提交计划，并在用户批准后退出计划模式开始实现。清晰授权的实现任务默认直接推进到验证，不因复杂、多文件或需要调查而额外增加规划审批。

计划正文通过 `ExitPlanMode.plan` 直接传入，批准后的文件仅用于下文规定的 compact/resume 连续性；不引入 auto mode gate、teammate mailbox 或专用 plan model。

## 工具

### EnterPlanMode

- 名称：`EnterPlanMode`
- 输入：空对象 `{}`
- 输出：`{ message, previousMode, mode: "plan" }`
- 能力：直接进入 plan mode，用于用户要求只读讨论、先审方案或关键方案尚待用户决策的只读探索和设计。
- 权限：`EnterPlanMode` 不弹用户审批，调用成功即切换到 plan mode。进入 plan 不放宽任何工具的权限：
  plan 只在原模式之上收紧，见 [Plan Mode Approval Boundary](../../../../../../docs/plan-mode-approval-boundary.md)。
- 副作用：`sideEffectScope: "session"`，不是 read-only。
- 并发：不安全，必须串行。mode 变更不能和其它 session mutation 并行。
- 失败：
  - 工具执行失败：返回 tool error，mode 不变。
  - runtime 未注入 session mode port：configuration error。

模型可见说明需覆盖：

- 仅当用户明确要求只读讨论或先审方案再实施，或关键方案选择确实需要用户决策、无法从请求、源码和合理默认值解决时使用。用户已批准的方案不重新审批。
- “先写 spec/设计文档”已授权文档产出，不因含有规划意图而自动进入禁止文件写入的 Plan；在当前权限允许时仅修改所要求的文档，不实施产品代码。如果用户已明确开启 Plan，则遵守既有边界，展示文档内容并说明写入需由宿主/用户切换模式，不能自行绕过。
- 复杂程度、多文件、新功能、常规实现选择、需要调查根因本身均不是进入条件；清晰授权的实现任务直接探索、实现、验证。
- 进入后使用实际可用的只读能力探索，识别既有模式和架构，设计实现方案；不要求调用当前缺席的搜索工具。
- 只在缺少用户才能提供的必要决策时澄清；工具可用时用 `AskUserQuestion`，否则直接提问。计划审批由 `ExitPlanMode` 承担，不先重复口头申请权限。
- 进入不弹审批，退出提交计划时请求审批；不能声称进入也需要用户确认。
- 纯研究直接完成调查并回答，不强制委派 Agent，也不为研究结果请求实现批准。

### ExitPlanMode

- 名称：`ExitPlanMode`
- 输入：
  - `plan: string`：展示给用户审批的计划正文。
  - `allowedPrompts?: { tool: "Bash"; prompt: string }[]`：第一版仅保留到输入/输出和 UI/permission projection，不自动写 permission rules。
- 输出：`{ plan, previousMode, mode, approved: true, allowedPrompts? }`
- 能力：在 plan mode 下提交最终计划，并请求用户同意退出 plan mode。
- 权限：必须走用户审批，包括从 `yolo` 进入的情况。审批通过后恢复进入 plan mode 前的 mode；没有记录时恢复 `build`。
- 副作用：`sideEffectScope: "session"`，不是 read-only。
- 并发：不安全，必须串行。
- 失败：
  - 当前不是 plan mode：稳定失败，不弹无意义审批。
  - `plan` 为空：schema 校验失败。
  - 用户拒绝：返回 permission denied tool error，保持 plan mode。

模型可见说明需覆盖：

- 只在 plan mode 中、已经完成实现计划、准备交给用户审批时调用。
- 工具必须通过 `plan` 参数传入完整计划；模型不要假设存在 plan file，也不要只发空输入。
- `plan` 参数就是用户审批时看到的内容，必须完整、明确、可执行。
- 本工具请求用户审批；从 `yolo` 进入 plan 时同样审批，通过后恢复 `yolo`。
- 只用于需要写代码的实现任务；纯研究、搜索文件、阅读文件、理解代码库时不要调用。
- 若仍缺少用户才能提供的关键决策，先澄清；工具可用时用 `AskUserQuestion`，否则直接提问。
- 不要用 `AskUserQuestion` 问“计划是否可以”或“是否继续”；审批就是本工具职责。
- 工具结果批准后，模型可以开始实现，并优先更新 todo（如果适用）。
- 模型提示需包含正反例：理解 vim mode 实现不应调用；已经在 Plan 中规划 yank mode 实现时，计划完成后调用；认证方案若确实不能从上下文合理选定，先澄清关键选择（Ask 可用时通过该工具），再提交计划。例子不能将普通实现任务自动升级为 Plan。

### 审批后 plan file 连续性

当前过渡实现仍保留 `ExitPlanMode({ plan, allowedPrompts? })` 的 provider-visible 输入形态。审批通过后，runtime 会把最终批准的 plan 原始字符串写入 workspace root 下的 `.zcode/plans/plan-${sanitizedSessionId}.md`；写入失败不阻断已批准的退出 plan mode，只会让后续 compact continuity 降级为没有 plan file reference。

这个文件不是新的 provider-visible input，也不是完整的 plan-file schema；它只用于 compact/resume continuity。compact 成功时，如果该 plan file 存在且非空，runtime 会在 compact 后历史中持久化 `plan_file_reference` model-only reminder：

```text
A plan file exists from plan mode at: ${planFilePath}

Plan contents:

${planContent}

If this plan is relevant to the current work and not already complete, continue working on it.
```

这样即使 `ExitPlanMode` 后立即 compact，恢复后的下一轮 provider context 仍能拿到完整批准计划。

投影角色：`plan_file_reference` 和其他 compaction 附件一样参与冒泡，附件之间保持生成顺序（文件恢复之后、runtime_mode 之前）。支持 MCS 时它进入 user run 末尾的 mid-conversation system 消息，不留在 user 侧；不支持 MCS 时它是 user 侧 reminder。

当前过渡实现没有新增 plan file retention cleanup。如需按保留天数清理 plans 目录中过期的 `.md`，应作为独立 retention cleanup 改造接入，而不是在 compact/session 时即时删除。

## 规划提醒

主会话完整提醒陈述当前 Plan 状态，不把模型自行进入模式说成用户要求停止执行。规划期间仍禁止写文件，不授予 plan file 编辑例外；只读约束与现有权限服务保持一致。

- 阅读完成任务所需的代码，复用已有实现；方案包含目标、关键修改路径、实现方式和验证方法，深度与任务相称。
- 不强制五阶段流程、Explore 类型或固定子代理数量；只有缺少用户才能提供的关键决策时才澄清。
- 有实现计划要审批时，通过 `ExitPlanMode.plan` 传完整正文；纯研究直接返回结论，不要求以工具调用收尾。
- 提醒根据当前工具候选表决定是否指导调用 `AskUserQuestion` / `ExitPlanMode`；候选表包含可通过 ToolSearch 发现的 deferred 工具，不以本次 provider 已展开 schema 的名单判断缺失。缺少提问工具时用直接问题；缺少退出工具时展示计划并说明保持 Plan，不能把普通文字回复当成已完成模式切换。
- 轮内收集、compact 后重发与 context composition 预览共用同一会话类型和能力选择。

简短提醒保留只读、必要澄清、实现审批与纯研究可直接回答的规则；完整／简短提醒仍按现有五次用户输入间隔和每五次公告的周期切换。用户轮次按历史中的普通 user 消息计：真实的新 prompt、开启新一轮的后台通知与 agent 回复、中断标记、compact summary 都计入；轮内插入的中途消息（含人类 steer）不计入间隔（中途消息是 attachment，不是用户轮次）。
当前轮的 prompt 在模型回应它之前不计入：轮首请求前的收集不计它，该轮工具批次之后的收集才计入。
所以间隔满五次的那一轮，轮首请求不发提醒，第一个工具批次之后的请求才发；该轮只有文本回复时，
提醒在下一个 prompt 的轮首请求发出。
两种计数都只检查最近一次 `plan_mode_exit` 之后的历史。退出边界之前的用户输入和
规划提醒不参与新一段计划模式的计数；重新进入时立即发完整提醒，之后从该提醒重新
计算间隔与完整／简短周期。退出提醒的正文和权限行为保持不变。
完整、简短和退出提醒与其他动态公告一样按隐藏提醒持久化（不写顶层 source），
`runtimeMessage.source` 保留 `runtime_mode` 或 `plan_mode_exit`。保存成功后才加入
请求历史并消费退出标记；冷恢复复用现有 hydration，保留原位置、正文和计数边界，
不因重启额外注入完整提醒。旧会话缺少这些历史记录时，沿用缺少提醒时的首次注入规则。
批准后的计划持久化和 compact/resume 连续性沿用上节合同。

子会话（Agent 工具派生、`taskType: "subagent_child"`）继承父会话的 Plan 状态时，只收到精简提醒：
声明 Plan 已开启、只能做只读操作、完整回答委派的查询；子会话可见 `AskUserQuestion` 时，再提示可以用它澄清。
精简提醒不含五阶段流程，也不要求以 `AskUserQuestion` 或 `ExitPlanMode` 结束本轮（子会话没有
`ExitPlanMode`，也不能再派生子 agent）。提醒间隔、持久化与恢复规则与主会话相同，不区分完整与简短；compact 后重发提醒时
同样按会话类型选择正文，子会话重发的仍是精简提醒。
修复原因：继承父会话 Plan 的子会话曾收到主会话的完整五阶段提醒，被要求再派生 Explore、只能以
`AskUserQuestion` 或 `ExitPlanMode` 收尾，而这些工具子会话都没有。

## Runtime 和事件

工具 handler 不直接 import bootstrap 或 UI 状态。core 通过 `SessionModePort` 注入 mode 操作：

- `getMode()`
- `getPrePlanMode()`
- `enterPlanMode({ toolCallId, traceContext })`
- `exitPlanMode({ toolCallId, traceContext })`

runtime 实现负责保存 `prePlanMode`、更新 `config.mode`、写入 `SessionModeChanged` event，并在退出后设置一次性 `plan_mode_exit` reminder。事件 reducer 必须用该事件更新 `SessionProjection.mode`，使 snapshot、resume、debug 和 ZCode app-server 看到同一事实。

## UI / ZCode app-server

- permission request 仍复用现有 `PermissionRequested` / `PermissionResolved` 协议。
- `ExitPlanMode` 的 `plan` 留在 tool input / result payload 中，现有 plan mode tool panel 可解析展示。
- desktop continuous 和 web remote replayable 都只消费 session event / snapshot；relay 与 main 不保存 plan mode 业务状态。

## 测试

- contracts：输入输出 schema 成功/失败，JSON Schema 投影。
- core：registry 暴露两个工具；metadata/permission 不伪装 read-only。
- permission：`EnterPlanMode` 直接 allow；`ExitPlanMode` 无论从何种模式进入都请求审批；两者都不会被 read-only 禁令误挡。
- permission：其他工具在 plan 下先过 Plan 闸门再按原模式判定，plan 不比原模式宽；
  需审批的只读工具交给原模式，非只读 MCP 在 build/edit 下单次询问且 allow 规则不能跳过。
  规则见 [Plan Mode Approval Boundary](../../../../../../docs/plan-mode-approval-boundary.md)。
- runtime：`EnterPlanMode` 调用成功后 mode=plan；`ExitPlanMode` 审批通过后恢复 previous mode；拒绝后 mode 不变。
- events：`SessionModeChanged` 能更新 projection，snapshot 使用 projection mode。
- reminder：退出后下一轮注入 `plan_mode_exit`，且只注入一次。
- provider 提示：最终请求包含“多文件实现和 bug 调查不是单独触发条件”“只读讨论、先审方案或关键方案未决才进入”“先写 spec 只授权文档产出”的规则；进入免审批、退出审批说明一致。
- reminder：主会话不虚构用户意图、不强制五阶段或 Explore；纯研究可回答；缺少 Ask/Exit 工具不指导调用，deferred 工具仍视为可发现；子会话继续只读且不要求退出工具。
- 离线测试只证明规则和能力分支正确送达；实际是否减少无必要 Plan、是否完成任务，由主 system spec 的固定任务集 A/B 单独验证。
