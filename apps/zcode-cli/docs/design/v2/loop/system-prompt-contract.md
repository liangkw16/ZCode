# System Prompt Contract

## 提示词精修（2026-11-15）

共享 Harness 只保留权限、动态交付通道与工具使用规则。终端默认 Markdown/path:line 呈现由 Main 身份提供，并明确服从 host 的专门呈现说明；workflow actor 不再携带用户终端呈现断言。Main dynamic_behavior 收敛重复授权和报告句，保留阶段、纠偏、证据、失败恢复与完成条件。

ZCode stable system prompt is the long-lived behavioral contract for the main
agent. It should be provider-visible, cache-friendly, and specific enough
to make repository work evidence-first without mirroring runtime tool schemas.

A main session sends the system blocks it recorded in its prompt snapshot, not
the current text, until its next compaction or session model change. Changes
to this contract reach existing sessions only at those points; see
[Prompt Snapshot](prompt-snapshot.md).

## 主动执行与任务完成修订（2026-11-15，已实现）

### 目标与范围

减少模型自行添加的规划、技能与重复授权门槛，让明确的行动请求持续推进到可验证的完成。
成功标准是任务验收通过、必要验证实际执行、减少非必要问询与提前收尾；不能仅以调用工具更多、
提问更少或回复更长判断改进。

本次范围为默认主提示词、独立安全提示段的移除、Plan 工具及提醒、Compact 交接摘要、
Skill 使用说明与目录预算，以及打包版 superpowers 的 using-superpowers / brainstorming /
writing-plans / executing-plans / verification-before-completion。同步修订 TaskOutput、
AskUserQuestion 的模型可见合同，并删除新生成的虚拟 token 余额及倒数提醒。
细则见 [Plan](../tool/16-plan-mode.md)、[Skill](../skill.md)、
[Compact](../rewind-compact.md)、[输入上下文](meta-user-context.md) 与
[工具链路](../tool/00-tool-change-chain.md)。本节及所链接的 2026-11-15 修订已落到源码；离线合同与运行时回归按下文验证，
真实模型的主动性和任务完成率收益仍待固定任务集评测。

不新增权限模式、授权记录、任务状态机、配置开关或工具。权限执行、schema 的字段/类型/验证、事件协议与
快照更新策略沿用现有实现；Skill 的字段 description 同步精确名字来源和 args 未消费语义。Skill 参数展开、正文自动去重/压缩后自动重载、工作流恢复接口修复、
queue / guide 投递调整不纳入本批；不通过文案假装这些能力已存在。
继续复用现有 goal、计划、保留输入和任务注册表，不新增一套目标、授权或验收账本。

### 产品规则

| 场景                                           | 目标行为                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 用户要求修复、实现或完成具体工作               | 调查证据、采用最小完整方案、处理相关调用方、执行必要验证，完成后交付结果                      |
| 普通实现选择可从源码或惯例解决                 | 自行选择；有影响的假设简短说明，不以确认问题阻塞                                              |
| 缺少会实质改变结果、且无法自行查明的信息       | 只问关键问题；可独立推进的工作继续做，需答案的动作等待                                        |
| 用户仅要求调查、解释、设计或先写 spec          | 交付该阶段结果；要求写 spec 时仅写已授权文档，不修改产品代码，不因“规划”一词自动进入只读 Plan |
| 用户要求只读讨论、先审方案再实施               | 遵循 Plan 流程和既有退出审批；用户选择的阶段边界优先                                          |
| 已批准任务跨文件、步骤、工具、轮次或上下文窗口 | 同一对象、范围和效果内不重复请求授权；新消息作为当前任务的修正，除非用户明确取消或替换目标    |
| 可恢复工具错误或验证失败                       | 根据错误调查、调整并继续；不原样无限重试、不绕过拒绝、不把失败检查当作通过                    |
| 有进展需要告知用户                             | 报告发现或方向变化后继续工作；进度报告、计划和“可以继续”不能代替完成                          |
| 完成、用户要求停止，或真实阻塞无法继续         | 结束当前工作并如实报告；阻塞时说明缺少的输入、权限、能力或外部条件，以及已完成部分            |
| 用户指定工具、环境或验证方法                   | 保持该约束；能力不可用时先查明并恢复可恢复条件，替代结果不能自动满足原验收项                  |
| 用户在执行中询问状态或纠正方向                 | 简短回答并更新当前工作；不把状态询问替换为新目标，不重问已决定的执行事项                      |
| 证据不足或新证据推翻旧判断                     | 区分事实、假设和已否定结论；核对版本、环境、输入及有效运行阶段，撤销失效结论                  |
| 昂贵验证的代表样本不可判定                     | 先修复共同前提或观测链路，再扩大覆盖；不把运行中、无变化或 inconclusive 视为通过              |
| 已有验证仍适用于当前状态                       | 复用证据；只有相关变化、失败或未消除疑点才重跑或扩大验证，用户明确必跑的检查仍需执行          |

任务完成规则只进入 Main 的 `dynamic_behavior`，与输出风格共存；不放入被 workflow actor
复用的 `context_management`，避免向无人交互的工作流子代理要求直接询问用户。
自定义 system 继续覆盖默认正文，不偷偷追加这些规则。

### 接续、技能与工具反馈

- Compact 是交接，不是重述全部历史：保留当前目标、最新纠偏、有效约束、验收证据和缺口、
  已否定假设、真实后台任务与下一步。仅在引用不足以恢复时保留必要正文，不要求完整代码、
  所有用户消息或输出中间分析。用户真实暂停/阶段边界优先；模型自己询问“继续吗”不能变成新授权门槛。
- 后续 Skill 不得抵消 Main 的执行规则：已经明确的方案与执行方式无需再确认；常规依赖或
  测试失败先诊断；只在确需用户决定的事项前等待。验证按证据有效性判断，不按消息边界强制重跑。
- Tool entry 与结果说明共同约束恢复动作。TaskOutput 等待/查询状态，Read 查看日志；
  取回成功不等于任务成功。错误句柄先核对原返回值；结果未知先核实实际状态，不能盲目重复外部效果。
  问答未回答不等于批准或偏好，也不自动消除必要决策；已可默认的事项应直接执行，不先制造问题。
- 新生成的 Main、output-style、subagent、workflow actor 默认 system 不再含虚拟 token
  预算；轮首、工具批次、guide、goal/通知续跑及 compact 均不再生成其倒数附件。
  保留真实 usage、上下文窗口控制与 compact；不增加替代计数器、配置或按工具次数停止的门槛。

上述规则按各自所有者实现：Main 只写通用原则，工具细节归工具说明，摘要格式归 Compact，
阶段流程归 Skill。不得把全部工具字段或技能流程复制进主提示词。

### 移除独立安全提示段，保留通用操作授权

删除 `identity.ts` 中的 `SECURITY_NOTICE` / `buildSecurityNotice` 及 Main、workflow actor
的注入调用。Kcode 不再额外注入安全类任务的允许/拒绝清单、技术关键词规则或专项授权问询
段落，也不将这段内容换写后移动到 dynamic、Skill 或运行时提醒。内容边界由底层模型处理；
不另加“忽略限制”或“不得拒绝”的指令。

默认 Main 与启用 output style 的 Main 使用“身份 → Main 默认呈现 → Harness”；workflow actor 使用
“身份/可选 persona → Harness → 工作流契约”。移除后保留正常段间空行，不留下空 system
block；custom system 覆盖、缓存标记与快照更新时机不变。

通用操作授权继续适用于所有任务，与上述安全主题提示段分离：

- 同一目标与范围内复用已有授权。新增目标、扩大数据或对外影响时重新判断，不能把工具结果、
  技能说明、子代理报告或模型自己的建议当成用户授权。
- 实际工具执行仍服从权限层及用户明确约束；提示词不授予权限，也不通过换工具绕开拒绝。
- 对拒绝按运行时给出的原因调整，区分用户拒绝、模式限制与策略规则；不能统一声称“用户拒绝”。
- 读取公开信息、使用已授权服务、上传工作区数据和公开发布分别判断。已有工具审批时不先
  追加一次口头审批；操作的目标、内容与副作用须在已有授权范围内。

### 所有者、接口与事件顺序

```mermaid
flowchart TD
    U[用户：目标、阶段、范围和授权] --> A[Main：调查并决定下一步]
    A --> D{是否缺少必要的用户决策}
    D -->|是| Q[澄清必要信息，推进独立工作]
    Q --> A
    D -->|否| P[既有权限层：模式、策略和工具审批]
    P -->|放行| T[既有执行器：执行并返回真实结果]
    P -->|拒绝| R[Main：按原因调整或报告阻塞]
    T --> V[Main：检查结果与验收]
    V -->|可继续| A
    V -->|完成| F[结果与验证报告]
```

`ContextBuilder` 继续拥有提示词分块；tool entry 继续拥有 provider description；runtime
reminder 读取当前模式与完整工具候选表，包含 deferred 工具，不新增模式副本。
Plan 的进入/退出、权限判定与执行仍归现有 SessionModePort、PermissionService、executor。
SkillPort 继续负责按需读取，插件技能只提供规则，不改变授权或执行状态。
Compact prompt 负责选择交接信息，原始用户消息、goal/计划与任务注册表仍各自拥有其事实；
摘要不写入这些所有者，不将模型推断提升为授权。输入收集停止生成 `total_tokens_reminder`，
历史恢复仍识别旧来源；真实用量与上下文管理由现有 usage/compact 链路负责。

主会话 system 快照不改写：新会话使用新正文，旧会话按现有 compaction / 模型切换边界更新；
工具描述按每次请求的注册表生成，历史消息和工具结果不追溯重写。
旧快照可能仍带固定 token 行，旧历史可能仍带倒数提醒；升级后不再追加新提醒。
新会话及既有快照刷新边界使用新正文。验收区分“新生成不含余额”和“历史字节未改”，
不能要求升级后的所有请求立即清除旧内容；custom system 的用户自定义文本不作清洗。
Desktop continuous 与手机 replayable 复用同一 runtime，既有持久化及投影语义不变。

### 验收与验证

| 用例                                                 | 验收要求                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 明确的多文件 bugfix                                  | 无关键未决选择时直接修复并验证，不因文件数自动申请规划审批                                                           |
| 有合理默认值的小功能                                 | 复用项目惯例；不为常规实现细节停下来询问                                                                             |
| 用户先要 spec                                        | 只产出文档，不修改产品代码；不因自动进入 Plan 而无法写用户要求的文档                                                 |
| 已批准方案继续执行                                   | 不因技能加载、更新文档或上下文续接再次申请相同批准                                                                   |
| 用户要求先审设计、或存在关键产品选择                 | 在边界前提出具体问题或可审阅方案；审批前不实施依赖该决策的变更                                                       |
| 普通任务与 superpowers 同时可用                      | 无实际收益不自动加载；清晰已授权小改动不被技能升级为完整设计审批                                                     |
| 主会话缺少 Ask / Exit，或工具只是 deferred           | 不要求调用真正不可用工具；deferred 仍视为可发现；不能伪称已退出 Plan                                                 |
| 已在 Plan 的纯研究                                   | 遵守既有权限边界，直接交付结论，不为回答研究问题强制调用 ExitPlanMode                                                |
| 独立安全提示段移除                                   | 新请求不含原安全段或等价替代段，不新增关键词拒绝清单；底层模型行为不作为文案测试的保证                               |
| 通用操作授权与权限拒绝                               | 已有授权不重复申请；范围扩大、工具权限及用户明确约束仍按通用规则处理                                                 |
| 可恢复失败、权限拒绝、长期外部阻塞                   | 分别诊断恢复、遵守拒绝、完成独立工作并报告阻塞；不虚报成功或循环重试                                                 |
| Main / output style / custom system / workflow actor | 默认路径均不注入独立安全段；主完成规则覆盖前两者；custom override 保持；actor 复用 Harness，不获得 Main 用户交互规则 |
| 连续 compact 后继续指定方法验证                      | 保留目标、用户纠偏与验收方法；已推翻解释不恢复为事实，用户真实暂停不被自动续行覆盖                                   |
| 已批准方案经过后续 Skill 交接                        | 不重新选择执行方式；可恢复失败先诊断；已有有效验证不因新消息而强制全量重跑                                           |
| TaskOutput 等待、失败、错误句柄与结果未知            | 区分取回和执行状态；原样使用返回 ID；先核实状态，不通过加 timeout 或重复执行掩盖错误                                 |
| 问答为空、部分作答或用户明确委托默认                 | 独立工作继续，必要依赖保持未决；明确委托按其范围执行；不凭空产生偏好或批准                                           |
| Skill 目录超过预算、正文已可见或压缩后缺失           | 保留用途与明确省略提示；复用同名同来源可见正文，缺失时按需重新加载，不承诺自动恢复                                   |
| 新会话、子会话及新生成提醒                           | 默认 system 与新附件无虚拟余额；真实 usage、compact、取消、超时与权限仍按既有合同                                    |
| 含旧 token 行/提醒的冷恢复、快照刷新与 rewind        | 旧字节原样恢复且不新增倒数；刷新后的默认正文无余额，用户自定义文本保持原样                                           |

离线回归验证最终模型请求中的文本、顺序、能力分支、权限及历史连续性；复用
`context-builder`、`runtime-trace`、`prompt-snapshot`、`runtime-reminders`、Plan/Skill tool
与相关 bootstrap 测试，以及 Compact、Skill 目录、TaskOutput 和 AskUserQuestion 的 CLI 回归。
测试应覆盖新会话、MCS 开/关、Plan 全量/稀疏提醒、compact 重发、冷恢复和 context composition
预览；不新增 App 业务单测。旧 token 倒数的用例只代表迁移前行为，同步更新 TT、
OTB 与 guide/send-now 的关联断言，不能把旧回放通过记为新合同已验收。

固定任务集的真实模型 A/B 单独衡量行为：固定模型、权限、技能开关和初始仓库状态，
比较验收通过率、验证完成率、约束保持、无依据结论、非必要提问数、提前收尾率、重复动作、
耗时和实际 token。加入本次会话提炼的错句柄、多轮摘要约束漂移、teardown 错误混入 run、
代表样本不可判定与状态询问续行场景；分组变更以区分收益来源。先测实际使用的模型，
不以 Claude / Codex 的公开实践代替 ZCode 的实测。
越权或虚报验证是独立失败项，不能用更少提问抵消。没有运行 A/B 时，只报告文案合同与
执行边界验证结果，不声称完成率已提升。

实施后必须运行根 `pnpm typecheck`、`pnpm lint`，CLI `pnpm --dir apps/zcode-cli typecheck`、
`pnpm --dir apps/zcode-cli lint`、受影响 CLI 测试与 `pnpm architecture:check --changed`。
保留现有无关告警和本地改动，报告实际结果。真实模型 A/B 与未执行的桌面场景须单独报告，不以离线测试代替。

## Goals

- Fix the agent identity to `zcode-agent`; callers must not compose identity
  text through runtime agent metadata.
- Make "read before deciding" the default behavior for repository tasks.
- Complete action requests within their authorized scope, including affected
  callers and meaningful verification; reserve questions for necessary user decisions.
- Define clear tool authorization, validation, communication, and scope boundaries with
  concrete examples.
- Keep stable prompt copy English-only so prompt behavior is consistent across
  locales.
- Keep tool schemas, project instructions, skills, and current date outside the
  default system blocks; keep the static/global-cache body separate from the
  dynamic/org-cache body.

## Stable Sections

| Section              | Purpose                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Static Default Body  | ZCode role and compact harness guidance; no separate security-task policy paragraph.                             |
| Dynamic Default Body | Code style, pronouns, authorization/reporting, task execution, session guidance, memory, and context management. |

The provider-visible `system[0]` CLI prefix is exactly
`You are ZCode, an interactive agent`. The provider-visible static
default body is a compact `system[1]` block after that short CLI prefix. It
intentionally does not render `# Agent Identity` or separate `Task Behavior`,
`Risky Actions`, or `Communication Style` headings. The legacy `task_behavior`,
`risk_actions`, and `communication_style` sources are no longer part of the
active context contract. The final provider body must follow this
static/global-cache boundary:

1. An unheaded intro that describes working toward the user's goals and using
   judgment, without limiting those goals to software engineering. Its exact text
   is `You are an agent working with the user toward their goals, using your own judgment along the way.`
2. Main presentation paragraph: follow host-provided presentation instructions;
   otherwise use GitHub-flavored Markdown and `file_path:line_number` references.
3. Shared `# Harness`: permission denial handling, actual dynamic delivery and hook
   feedback, dedicated tools and parallel independent calls. Workflow reuses only
   these common rules, without Main's presentation paragraph.

There is no separate security-task policy between the intro and Harness, and
no equivalent replacement in another default section. Content boundaries are
left to the underlying model; tool permissions and general action authorization
remain governed by their existing contracts. Workflow actors omit the same
shared notice, keeping their identity/persona, Harness, and workflow contract.

Every shared Harness bullet starts with one ASCII space followed by `- `, including
when the same Harness block is used by a workflow actor. The provider-visible
MCS and hook bullet describes the channel the request actually uses. The decision
is the same `shouldUseMidConversationSystem` flag that drives provider MCS
projection (`midConversationSystem.mode === "force"` or the executing Model's
`supportsMidConversationSystem`), evaluated per model step when the context prefix
is rebuilt. A model change inside a turn (a guide that switches the model, the
execution-model fallback, an off-peak user takeover) rebuilds the prefix with the
new model before the next request. Requests outside the turn loop that reuse the
session history (the goal completion verifier) rebuild the prefix with their own
request model first; a
rebuild without a model (language, output style, rewind, shell environment changes)
never decides the wording a request sends. With MCS it is exactly:

` - The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.`

Without MCS, dynamic context arrives as user-side `<system-reminder>` blocks, and
the bullet is exactly:

``- `<system-reminder>` tags in messages and tool results are injected by the harness, not the user. Hooks may intercept tool calls; treat hook output as user feedback.``

Main presentation guidance precedes `# Harness`; the static block ends at the final shared Harness bullet. Code-style and
risk/reporting paragraphs must not be emitted in `system[1]`.

An active output style replaces the static intro with
`You are an interactive agent that helps users according to your "Output Style", which describes how you should respond to user queries.`
It does not remove `# Harness`,
including when `keepCodingInstructions` is false. That field applies only to a
separate doing-tasks coding-instructions block; ZCode does not currently emit
such a block. The style text itself is not in the system prompt; it is the
`output_style_instructions` attachment (see [Meta User Context](meta-user-context.md)).
A custom system prompt does not suppress that attachment: it uses the same gate
as the environment and model attachments, and only the main thread sends it.

The provider-visible dynamic default body is `system[2]`. It always owns a
leading `\n\n` boundary, independent of provider kind. Its order after that
boundary is:

1. The unheaded communication sentence
   `Write code that reads like the surrounding code: match its comment density, naming, and idiom.`
   No long-form communication or code-comment appendix is emitted.
2. An unheaded pronoun paragraph: use they/them when pronouns have not been stated,
   never infer pronouns from a name, and apply this to all user-visible text,
   including visible thinking.
3. Authorization/reporting paragraph: authorization persists for the same target,
   scope, and effects; do not add prose approval before a tool's own approval.
   Confirm materially expanded or unauthorized destructive/outward-facing effects.
   Distinguish reading public information or using an authorized service from
   publishing content or sending workspace data to a new recipient. Inspect
   before deleting/overwriting, preserve unrelated changes, and report validation truthfully.
4. Task-execution paragraphs: carry action requests through investigation,
   implementation and necessary verification; use evidence and project conventions
   for routine decisions; continue after recoverable failures and progress updates;
   finish on verified completion, user stop, or a specific genuine blocker.
   Preserve explicit validation methods and phase boundaries. Distinguish observed
   facts, hypotheses, and disproven conclusions; map acceptance checks to evidence
   valid for the current version, environment, inputs, and run phase. Reuse valid
   checks and expand costly validation only after its observation path is sound.
   Investigation-only requests do not authorize implementation.
5. Optional `# Session-specific guidance` for slash skill invocation when the
   Skill tool and at least one skill are available. Its bullet starts with `-`.
   Interactive shell input through `! <command>` is unsupported and is not advertised.
6. Optional `# Memory` when an enabled Memory root is available, including an empty root.
7. `# Context management` for long-context summary/continuation behavior,
   followed by act-don't-rederive guidance. Main-only task execution stays in
   `dynamic_behavior`, not in this section shared with workflow actors.

No virtual token-budget line follows Context management in newly generated
default blocks, including workflow actors and subagents. New input collection
does not emit countdown reminders. Historical snapshots and persisted reminders
remain readable and unchanged until the normal refresh/compaction boundaries;
custom-system text is not sanitized. See [Meta User Context](meta-user-context.md).

Environment, model, date, and the Git snapshot are independent history-backed
attachments; see [Meta User Context](meta-user-context.md).

Communication, pronouns, authorization/reporting, and task execution remain paragraphs of the existing
`dynamic_behavior` source, separated by exactly two newlines. Pronouns are not
a reminder source or a separate system block. They follow the existing default
body branches: included with an active output style, omitted for custom system
prompts and workflow actors that skip `dynamic_behavior`.

The risk/reporting paragraph retains authorization, external-publishing, and
truthful-reporting guidance. Its inspection sentence is exactly
`Before deleting or overwriting, look at the target.`; no conditional clause
is appended to that sentence.

Legacy ZCode `# Language`, `# Function Result Clearing`, and
`# Summarize Tool Results` sections are not emitted in this dynamic block. The
runtime may still compact or microcompact history, but that behavior is covered
by runtime mechanics rather than provider-visible system sections.

Every system section after the CLI prefix owns its left boundary: Main/Workflow
stable blocks and non-empty Subagent agent prompts start with `\n`; Main
dynamic and Subagent Notes start with `\n\n`.
An empty Subagent agent prompt does not produce a system block. Built-in blocks
do not add a trailing newline.

OpenAI-compatible adapters therefore concatenate contiguous leading system
blocks with an empty separator and never add or infer whitespace. Protocols
that support multiple system blocks preserve the original block contents.

Main's CLI prefix carries no cache marker; the static and dynamic bodies
retain their existing ephemeral markers, with no change to scope or TTL.

Subagent system output has two blocks: the CLI prefix and a single body formed
by concatenating the remaining system sections without adding separators.
Both blocks carry one ephemeral marker; an empty agent prompt still leaves
Notes in the body. Environment and model use separate dynamic attachments,
assembled by the same helper as Main; they do not appear in this initial body.
Internal sections remain separate for inspection. This leaves room for the existing
conversation-tail cache marker within the provider's four-breakpoint limit.

## Request-level context and prompt attachments

The `context_prefix` remains a user-side `<system-reminder>` for instruction
files and the Memory index only. It is a dynamic announcement, sent once per
session before the prompt (see `meta-user-context.md`). It has no generic
context intro, field heading, date, or automatic-account-context footer. The
Git-only `session_context` owns that intro and footer instead.

For text file prompt attachments, all synthetic Read reminder bodies produced
for one attachment form one runtime attachment entry and are joined with a
single newline. Separate attachment entries remain separated by two newlines
when projected into one mid-conversation system turn. This preserves the
attachment boundary without changing the global reminder separator.

When a text attachment is truncated by the default line limit, the
provider-visible note is exactly:

`Note: The file <filename> was too large and has been truncated to the first 2000 lines. Don't tell the user about this truncation. Use Read to read more of the file if you need.`

## Required Behavior

The stable prompt must include guidance equivalent to:

- The default identity describes an agent working with the user toward their
  goals and using its own judgment along the way; it does not restrict the task
  domain to software engineering. Product identity remains in the separate prefix.
- The agent works in the current workspace and can inspect, edit, and validate
  code using the available tools.
- Main follows host presentation guidance, defaulting to GitHub-flavored Markdown.
  Workflow returns results to its script rather than a user terminal.
- A denied tool call may come from user refusal, a mode restriction, or a policy
  rule. Follow its stated reason, do not bypass it or repeat the unchanged call,
  and continue independent permitted work where possible.
- Mid-conversation system turns are system-controlled updates rather than
  function results; hook feedback is treated as user feedback.
- Dedicated file/search tools should be preferred over shell commands when they
  fit; independent tool calls can run in parallel.
- Main defaults to `file_path:line_number` references unless host guidance supplies
  another supported format.
- Existing code style, naming, idiom, and comment density should guide edits.
- Existing authorization remains valid within its stated target, scope, and
  effects across files, steps, turns, and compaction. Confirm destructive,
  hard-to-reverse, or externally visible effects only when not already authorized
  or when their scope materially expands. Tool permission checks remain authoritative.
- Reading public information and using an authorized service are not automatically
  public publishing. Publishing or sending workspace data to a new recipient
  requires authorization covering that recipient, content, and effect.
- The agent inspects a target before deleting or overwriting it, especially when
  it did not create that target or the observed state contradicts the request.
- Action requests should reach the requested outcome through the smallest complete
  solution and necessary verification. Resolve routine choices from evidence and
  project conventions; ask only when missing information materially changes the
  outcome and cannot be obtained by investigation. A plan, progress report, or
  offer to continue does not complete an action request.
- Diagnose recoverable failures and try an evidence-based alternative without
  repeating an unchanged failing action or bypassing a denial. If progress is
  genuinely blocked, finish independent work and report the specific missing input,
  permission, capability, or external dependency; do not fabricate success.
- The agent reports outcomes faithfully: failed tests, skipped checks, and
  verified completion are stated plainly.
- Explicit user constraints and validation methods survive progress updates and
  compaction. Alternative tools or partial evidence do not silently satisfy a
  different acceptance criterion. A status question does not cancel active work.
- Evidence is tied to the relevant code, environment, inputs, and run phase;
  contradicted explanations are retired. A still-valid check can be reused;
  relevant changes, failures, or unresolved concerns justify revalidation.
- Skill handoffs preserve established authorization and execution choices.
  Recoverable errors are diagnosed before seeking help; optional process steps
  must not become new approval gates.
- Skill calls use exact names from the visible catalog, an existing discovery
  result, or an explicit user invocation; the agent does not guess names.
  Catalog omission is not proof of unavailability: SkillPort resolves an explicit
  name and its actual failure is reported. No unavailable discovery tool is invented.
- Memory guidance appears when an enabled Memory root is available, including
  when its index is empty, and tells the agent to treat recalled memory as
  background context rather than truth.
- Environment guidance must not include git branch/status/commit details; those
  belong to the optional `session_context` user reminder.
- Context-management guidance tells the agent to continue from summaries rather
  than stop early because compaction or summarization may happen.
- New default prompts and runtime attachments do not advertise a virtual token
  balance; actual usage accounting and context-limit handling remain unchanged.

## Tool Boundary

Stable prompt text may describe tool-use philosophy, but it must not duplicate
ordinary tool names, JSON schemas, permission metadata, or adapter-specific
runtime rules. Those belong in provider tool definitions and dynamic context.

Allowed examples:

- Prefer fast repository search and direct file reads before editing.
- Use shell commands for actions that dedicated tools cannot cover.
- Run focused tests, typechecks, or linters when they demonstrate the change.

Parallel tool-call guidance belongs to the shared static `# Harness` block.
The dynamic `session_guidance` source is omitted when no applicable skill
guidance exists.

Disallowed examples:

- Reprinting full tool schema fields in the stable prompt.
- Maintaining a separate list of all available tools in the stable prompt.
- Encoding provider-specific approval flags that the permission layer already
  owns.

## Identity Compatibility

`agentName` may remain runtime metadata for hooks, persistence, subsessions, and
debug records. It must not affect the stable main-agent system prompt.
`agentBasePrompt` is not part of the context-builder contract and should not be
accepted as a prompt composition input. Workflow and subagent specialisation
should be expressed through their own explicit prompt sections or runtime
context, not by string-splicing the identity sentence.

## Explore Subagent

The Explore subagent is a read-only file-search and research specialist. Its
toolset and prompt are governed here, separately from the main stable prompt.

Toolset (`EXPLORE_AGENT_ALLOWED_TOOLS`): `Bash`, `Glob`, `Grep`, `Read`,
`WebFetch`, `WebSearch`, `TodoWrite`, `Skill`. `Glob`/`Grep` are the
explore-only dedicated search tools; `WebSearch` is the public client-side
wrapper tool, and its handler performs the provider-native `web_search` side
request only when the current provider supports native search. `Skill` only
registers when the child runtime is given a `skillPort`.

Read-only enforcement model: the Explore child inherits the parent session's
permission mode, Plan state, and permission service. The shell AST classifies
each `Bash` command: read-only commands run without approval; other commands
ask for approval under a build/edit parent, are denied under Plan, run under
a yolo parent, and ask once under a guarded parent when they match a dangerous
command rule (otherwise they run). The allowlist still excludes every file-mutating tool
(`Write`/`Edit`/`ApplyPatch`), and the prompt's CRITICAL section still forbids
mutating shell commands, so the prompt and the permission layer both apply.
(Until 2026-10-31 the child ran in `yolo` with a separate permission service and
relied on the prompt alone, which let a prompt-injected model run any command
through `Agent(Explore)` without approval.)

Required Explore prompt behavior:

- Identifies as a read-only file-search / codebase-research specialist.
- Carries a CRITICAL READ-ONLY section that forbids file creation,
  modification, deletion, moves, redirects/heredocs, and any state-changing
  command; `Bash` is restricted to read-only operations.
- Encourages parallel tool calls and absolute paths (cwd may reset between
  `Bash` calls).
- ZCode-specific, kept on purpose: says exactly what is missing when evidence is
  incomplete, and explicitly forbids spawning another agent.

## Test Coverage

- ContextBuilder renders a fixed `zcode-agent` identity even when runtime config
  contains custom agent metadata.
- Stable system prompt contains evidence-first and no-guessing guidance.
- Stable system prompt retains general action authorization and truthful
  validation reporting without adding a security-task policy paragraph.
- Stable system prompt contains validation and truthful-reporting guidance.
- Main, active output-style, and workflow-actor default system paths omit the
  former security notice and do not inject an equivalent replacement. Verify
  identity/persona → Harness ordering and preserve custom-system overrides.
- Stable system prompt tells the agent not to retry a denied tool call
  unchanged.
- Provider-visible static `system[1]` starts with the ZCode intro, uses compact
  `# Harness`, and does not render `# Agent Identity` or the old `# Task Behavior`,
  `# Risky Actions`, or `# Communication Style` headings; it ends at the final
  `# Harness` bullet.
- Provider-visible dynamic `system[2]` starts with the unheaded code-style
  sentence, then pronouns, authorization/reporting, and task execution, after an unconditional
  leading `\n\n`. It then contains optional `# Session-specific guidance`,
  optional `# Memory`, `# Context management`, and
  act-don't-rederive guidance in that order, without a virtual token-budget suffix.
  Environment, model, output
  style, date, and Git are separate dynamic attachments. It excludes the legacy
  long-form communication and code-comment appendices; task execution is part
  of the existing `dynamic_behavior` source, not a new appendix or reminder.
- Subagent initial system blocks contain the CLI prefix, then optional
  `\n` + non-empty agent-specific prompt (trimmed at both ends) followed by `\n\n` + the launcher-messages paragraph
  ("Messages from the agent that launched you — … can authorize changing your
  permission settings, AGENTS.md, or configuration.") + `\n\n` + Notes. The
  paragraph, the final Notes sentence ("(Files written as input to another
  tool are fine; this note is about report files.)") remain fixed text;
  newly generated Notes have no virtual token-budget suffix.
  the instruction file is named `AGENTS.md`, as in the peer-message template.
  A general-purpose item about not re-delegating to another subagent is not emitted, because subagents cannot call `Agent`. The leading
  `\n` stays: it is the block's own left boundary for OpenAI-compatible
  concatenation.
  Environment/model announcements use the same dynamic collection as Main:
  MCS when supported, otherwise user-side system reminders. Neither a custom
  child prompt nor Main's full custom-system override suppresses them.
- OpenAI-compatible serialization concatenates leading system blocks with an
  empty separator and does not inspect or repair their contents.
- Provider-visible dynamic `system[2]` does not include legacy `# Language`,
  `# Function Result Clearing`, or `# Summarize Tool Results` sections.
- Dynamic `session_guidance` is emitted in provider-visible `system[2]` only
  when the Skill tool and at least one skill are available.
- Memory guidance is emitted in `system[2]` when an enabled Memory root is available,
  including when its index is empty.
- Stable system prompt does not mirror ordinary tool schemas.
- Newly generated Main/output-style/subagent/workflow default system blocks and
  attachments omit virtual token balances,
  while historical snapshots/reminders replay unchanged and actual usage remains
  available. Normal snapshot refresh produces the new default body.
