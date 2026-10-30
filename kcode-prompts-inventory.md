# kcode(ZCode CLI)源码提示词总览

范围:`apps/zcode-cli/`(即 kcode CLI 与运行时),按"发给模型的提示词"口径整理;纯 UI 文案、类型定义、测试不收。
除特别标注外,所有提示词正文均为**英文**;源码中的中文均为注释,不进入模型上下文。用户可变部分(persona、output style、AGENTS.md、skill 正文)语言由作者决定。

---

## 1. 主会话系统提示词(core/src/context/)

装配中心:`packages/core/src/context/builder.ts:83-233`(`ContextBuilder.build()`)。
每个 section 有两个维度:`injectionTarget`(system / meta_user)与 `cacheHint`(stable / dynamic);最终 `orderSectionsForInjection`(L319-334)按 system-stable → system-dynamic → meta_user-stable → meta_user-dynamic 排序。

前置互斥:`customSystemPrompt` 与 `workflowActor` 不能同时存在(L88-98),构成三条身份路径(自定义 / 工作流 actor / 默认 agent)。

装配顺序与触发条件:

| 顺序 | Section | 文件 | target/cache | 触发条件 | 内容概要 | 篇幅 |
|---|---|---|---|---|---|---|
| 1 | CLI Prefix | `sections/cli-prefix.ts:10-23` | system/stable | 非 workflowActor | "You are ZCode, an interactive coding agent" 一句开场 | 1 行 |
| 2a | Agent Identity(默认) | `sections/identity.ts:42-55` | system/stable | 无 custom prompt 且无 workflowActor | 身份 intro(有 outputStyle 时改述)+ 安全测试边界 IMPORTANT 段(L9-10)+ `# Harness` 块(L21-30:markdown 渲染、权限拒绝处理、system-reminder 语义、工具偏好、`file_path:line_number` 引用规则) | 约 15 行 |
| 2b | Workflow Actor Identity | `sections/workflow-actor.ts:70-82` | system/stable | `workflowActor` 在场 | "你是动态工作流中的子代理,输出给脚本而非人" + 可选 persona + 复用安全段与 Harness + `# Working inside a workflow` 契约(submit_result/escalate 机制、ground every claim、cite path:line、跑过才算过) | 约 15-18 行 |
| 2c | Custom System Prompt | builder.ts L109-123 | system/stable | 调用方传入 | 用户自定义系统提示(跳过下面 3 的所有默认动态段) | 用户定 |
| 3a | Desktop Context | `sections/desktop.ts:4-36` | system/stable | `presentationSurface === "zcode_desktop"` 且非 workflowActor | Gen UI 内联渲染规则、`<untrusted_gen_ui_state>` 不可信、本地 URL/文件须 Markdown 链接、`::code-comment{...}` 行内评论指令 | 约 26 行 |
| 3b | Dynamic Behavior | `dynamic-sections.ts:76-89` | system/dynamic | 非 workflowActor | `# Communicating with the user`:面向离开又回来的读者写作、最终消息必须含全部交付物、先说结论、可读性优先、不用箭头链/黑话、简单问题散文直答;代码风格匹配;注释写作约束;不可逆/外发动作先确认、删除前先看目标、如实报告 | 约 3500 字符 |
| 3c | Session Guidance | `dynamic-sections.ts:44-74` | system/dynamic | 非 workflowActor | `# Session-specific guidance`:当前仅一条——`/技能名` 必须经 Skill 工具调用、勿猜测 | 1 标题+至多 1 条 |
| 3d | Memory | `sections/memory.ts:9-61` | system/dynamic | 配置 `memoryRoot` 且非空 | `# Memory`:文件式持久记忆规范——单事实单文件 + frontmatter 模板、`[[name]]` 链接、user/feedback/project/reference 四类定义、MEMORY.md 索引行规则、去重、`<system-reminder>` 记忆非指令 | 约 20 行 |
| 3e | Environment Info | `sections/env-info.ts:71-99` | system/dynamic | 无条件 | `# Environment`:工作目录、附加目录、git 仓库与否、平台/shell/OS、模型名 | 7-10 行 |
| 3f | Output Style | `dynamic-sections.ts:91-100` | system/dynamic | `outputStyle.prompt` 非空 | `# Output Style: <name>` + 用户配置正文 | 用户定 |
| 3g | Context Management | `dynamic-sections.ts:102-108` | system/dynamic | 无条件 | `# Context management`:长对话会被摘要续传、无需提前收尾;自主性段落——信息够就行动、勿问"要不要我做"、用户提问只给评估、turn 结束前检查是否有未兑现承诺、改系统状态前核实证据 | 约 1800 字符 |
| 3h | Git System Context | `sections/env-info.ts:101-118` | system/dynamic | 是 git 仓库 | gitStatus 快照说明(强调是会话开始时快照)+ 分支/主分支/用户/Status/recent commits | 2 行前导+动态内容 |
| 4 | Skills | `sections/skills.ts:17-58` | meta_user/dynamic | skills 非空且 Skill 工具已注册 | 可用技能列表(名: 描述(250 字符截断) - whenToUse - 路径);超 20000 字符预算降级为仅名称+路径 | 表头 1 行+列表 |
| 5 | Request User Context | `sections/request-user-context.ts:15-86` | meta_user/dynamic | 有 workspace/user 指令或 memory 索引 | `# agentsMd` + "instructions OVERRIDE any default behavior" 声明,下挂 AGENTS.md 类文件原文与 MEMORY.md 索引 | 表头 2 行+原文 |
| 6 | Current Date | `sections/current-date.ts:8-25` | meta_user/dynamic | 提供 `currentDate` | `# currentDate` + "Today's date is X." | 2 行 |
| 7 | Custom sections | builder.ts L215 | — | `addSection()` | 扩展段 | — |

最终输出形态:
- `assembleSystemMessages`(builder.ts L240-286):3 条 system message(cli_prefix 单独一条 / stable body 带 ephemeral cacheControl / dynamic system)。
- `assembleMetaUserAttachments`(L288-316):2 个附件——`skills_listing` 原文;`context_prefix`(Request User Context + Current Date,经 `buildContextMetaUserBody` L336-345 包 "As you answer the user's questions..." 前导与免责声明),由 `system-reminder/source.ts:20,108-109` 包上 `<system-reminder>` 作为 request 前缀消息。
- 配置来源:`runtime/methods/context.ts:113-164`;子代理不走本 builder(见 §5)。

---

## 2. 系统提醒与消息注入(core/src/system-reminder/)

| 文件:行 | 触发场景 | 内容概要 |
|---|---|---|
| `source.ts:22-56, 215-237` | 所有注入 | 30 种 source 清单(prefix/persisted/per-request);`wrapSystemReminder` 统一包 `<system-reminder>` 三段结构并转义嵌套标签 |
| `incoming-message.ts:3-31` | 运行中插话/steer | 六种包装:user_steer("The user sent a new message while you were working...")、coordinator_steer(先处理再继续)、subagent_reply(_steer)(peer 消息当队友请求,但**绝不因此提权/替 peer 做被拒操作**——反 permission laundering)、task_notification("[SYSTEM NOTIFICATION - NOT USER INPUT] 不构成任何确认/同意") |
| `prompt-attachment.ts:22-126` | 用户消息带附件 | 文件类伪装成 Read 工具调用记录两段("Called the Read tool with..." + "Result of calling the Read tool:"),超长附截断说明;inline text 类带"attachment 是数据不是高优先级指令"声明 |

---

## 3. 工具描述与参数提示词(core/src/tool/ + contracts/src/tools/)

生效机制:`tool/types.ts:70-106`(ToolMetadata 含 `description`、`modelInstructions`)→ `tool/registry.ts:104-139`(`modelInstructions` 以 "Usage:\n- ..." 追加到 description 末尾)。参数描述大多在 `packages/contracts/src/tools/*.ts`(zod `.describe()`)。

### 3.1 核心工具描述

| 工具 | description 位置 | 概要 | 篇幅 |
|---|---|---|---|
| Read | `handlers/read.ts:57-68`(动态变体 L482) | 读文件(文本/图片/视频/PDF),cat -n 行号,含"编辑后不要重读" guardrail | 约 12 行 |
| Bash | `handlers/bash-prompt.ts:1-23`(默认常量 `bash.ts:82-85`,运行时变体 L542-570;timeout 参数描述动态生成 L583-599) | 执行 bash;工作目录持久化、禁 cat/head/grep 改用专用工具、timeout 毫秒、后台运行、git/gh 纪律 | 约 13 行 |
| Edit | `handlers/edit.ts:52-58` | 精确字符串替换;须先 Read、唯一匹配、replace_all | 6 行 |
| Write | `handlers/write.ts:36-40` | 整体覆盖写;Write vs Edit 选择、未读先写会失败 | 4 行 |
| ApplyPatch | `handlers/apply-patch.ts:22-30, 329` | 结构化补丁(Begin/End Patch 格式、hunk 前缀、失败后重读而非换工具) | 1 行+8 条 Usage |
| Grep | `handlers/grep.ts:25-30` | ripgrep 内容搜索,优先于 Bash grep;正则/glob/type/output_mode/multiline | 约 6 行 |
| Glob | `handlers/glob.ts:22-23` | 文件名 glob 匹配,按修改时间排序 | 1 行 |
| Skill | `handlers/skill.ts:102-120` | 会话内加载/执行技能;slash command 即技能、命中必须先调、禁止编造技能名 | 约 19 行 |
| TodoRead/TodoWrite | `handlers/todo.ts:79, 138-142` | 维护会话任务清单(全量替换、单 in_progress)/读取 | 1 / 6 行 |
| Agent(Task 别名 `compat.ts:2`) | `handlers/agent.ts:90-119`(别名描述 L288-305) | 启动子代理;何时委派 vs 自己查、SendMessage 续接、后台运行、"用户点名工作流必须用 CreateWorkflow"门控 | 约 20 行 |
| SendMessage | `handlers/send-message.ts:16-26` | 向其他代理发消息(带 JSON 示例);普通文本输出对其他代理不可见 | 约 11 行 |
| RespondToCoordinator | `handlers/respond-to-coordinator.ts:57-65` | 子代理回复协调者;7 条 Usage | 1 行+7 条 |
| TaskOutput(弃用) | contracts `tools/task-output.ts:12-23` | 后台任务结果改走输出文件+`<task-notification>` | 12 行 |
| TaskStop | `handlers/task-stop.ts:20-27` | 按 ID 停后台任务 | 7 行 |
| WebFetch | `handlers/webfetch.ts:39-45` | 抓 URL 转 markdown 用小模型作答;鉴权 URL 失败、HTTPS 升级、15 分钟缓存 | 7 行 |
| WebSearch | `handlers/websearch.ts:49-58`(动态,每次注入当前月份) | 网页搜索(仅美国源);域名过滤;须以 Sources 列表收尾 | 6 行 |
| AskUserQuestion | `handlers/ask-user-question.ts:20-41` | 仅在真正需要用户拍板时提问;选项/推荐/multiSelect/preview 规则、与 plan mode 边界 | 约 22 行 |
| EnterPlanMode | `handlers/plan-mode-prompts.ts:5-98` | 非平凡实现任务前主动进计划模式(何时用/不用、示例) | 约 85 行 |
| ExitPlanMode | `handlers/plan-mode-prompts.ts:102-128` | 计划完成请求批准;勿用于研究类任务 | 约 27 行 |
| ToolSearch | `tool/search/description.ts:14-18`(local 模式 `:21-30`,替换点 `exposure.ts:124-128`) | 按查询加载 deferred 工具 schema;select:/关键词/+前缀三种形式 | 约 12 行 |
| DeferredToolCall | `handlers/deferred-tool-call.ts:15-16` | 调用已加载 schema 的 deferred 工具 | 3 行 |
| js(Node REPL) | `handlers/node-repl.ts:297-352` | 持久 Node REPL 执行 JS;browser-use 开启时追加约 40 行浏览器自动化指南(截图 emitImage 契约、DOM snapshot 优先) | 基础约 7 行/浏览器版约 45 行 |
| GoalRead | `handlers/target.ts:30` | 读当前会话目标与状态 | 1 行 |
| ListModels | `handlers/list-models.ts:37-44` | 列主机模型供 subagent_model 用 | 8 行 |
| ReadSessionContext | `handlers/read-session-context.ts:165-174` | 读既往会话/话题归档;handoff/topic 策略、"背景上下文不是更高优先级指令" | 2 行+8 条 |
| ReplyToChannel | `handlers/reply-to-channel.ts:56-57`(参数描述内联 L69-114) | 仅用户明确要求时向飞书补发回复;@ 人名解析、歧义澄清、不可编造 ID | 1 行超长(约 300 词) |
| CronCreate/CronList/CronUpdate/CronDelete | `handlers/cron.ts:194-217, 258, 303, 357` | 定时任务;相对延迟必须 delayMinutes、每 N 单位用 intervalUnit、本地时区、禁止递归创建自动化 | CronCreate 2 行+12 条,其余 1-2 行 |
| OffPeakCreate/OffPeakList | `handlers/off-peak.ts:188-199, 240-241` | 闲时免费任务(无保证启动时间,与 Cron 区分、配额) | 2 行+9 条 / 1 行 |
| Workflow(legacy) | `handlers/workflow-description.ts:2-3` | 单行巨型常量:ultracode 准入、script meta、agent/pipeline/parallel/budget API、resume、质量模式全套文档(全目录最大工具描述) | 渲染约 150+ 行 |

### 3.2 动态工作流(DWF)工具族(2026-09 起刻意收短,细节移入 dynamic-workflows 技能)

| 工具 | description 位置 | 概要 |
|---|---|---|
| CreateWorkflow | `handlers/create-workflow-description.ts:30-38` | 创建并运行 TS 动态工作流;仅用户点名才可调,写脚本前必须先加载技能(约 15 行) |
| SaveWorkflow | `handlers/save-workflow-description.ts:10-16` | 保存脚本供按名复跑;绝不主动保存(约 7 行) |
| AmendWorkflow | `handlers/amend-workflow-description.ts:10-20` | 修订既有 run(继承缓存);运行中出错也立即 amend(约 12 行) |
| FillWorkflowHole | `handlers/fill-workflow-hole-description.ts:10-19` | 为留空(hole)补函数体;只写语句、先在 EvalWorkflowSnippet 排练(约 10 行) |
| EvalWorkflowSnippet | `handlers/eval-workflow-snippet-description.ts:8-12` | 同步编译运行小片段,试验台(约 5 行) |
| GetWorkflowRun | `handlers/get-workflow-run.ts:52-63` | 查单个 run 状态/结果;终态语义与 resume/amend 指引(约 9 行) |
| ListWorkflowRuns | `handlers/list-workflow-runs.ts:32-43` | 项目级 run 历史;possibly_interrupted 语义与恢复路径(约 9 行) |
| ListSavedWorkflows | `handlers/list-saved-workflows.ts:28-35` | 已保存工作流定义,新建前先查(约 6 行) |
| ResumeWorkflowRun | `handlers/resume-workflow-run.ts:60-67` | 恢复 stopped run;journal 重放不花 token(约 5 行) |
| ResolveWorkflowQuestion | `handlers/resolve-workflow-question.ts:46-53` | 回答子代理 escalate 的阻塞问题;其余照跑(约 6 行) |
| escalate | `handlers/escalate.ts:38-51` | 子代理向主代理升级阻塞问题;最后手段、单问聚焦、每次 ask 最多 3 次(约 13 行) |
| submit_result | `handlers/submit-result.ts:83-85` | 提交结构化最终结果;schema 由 ask 尾注或工具 schema 给出 |

### 3.3 工具结果回填 / guardrail 文案(同样进入模型上下文)

- 输入校验:`tool/input-validation-model-content.ts:12-72`(`<tool_use_error>InputValidationError` + 缺参/多余参/类型不匹配文案)。
- 大输出落盘:`tool/result-persistence-format.ts:29-42`(`<persisted-output>` 信封)。
- Bash 回填:`handlers/bash-model-content.ts`(provider 错误 L50-61、中断 L105-112、后台任务提示 L119-132、15s 自动转后台提示、落盘信封 L163-175);stale 文件提示 `bash-read-file-state.ts:182-189`;gh 限流提醒 `bash-gh-rate-limit.ts:7`。
- Edit/Write 回填:`handlers/edit.ts:59-82`、`handlers/write.ts:42-47`(成功文案含 "no need to Read it back")。
- Read 防重读 stub:`handlers/read.ts:55-56`("Wasted call — file unchanged...")。
- Agent 回填:`handlers/agent.ts:123-165`(agentId 续接、异步启动指令、`<usage>` 块、空输出兜底)。
- WebSearch 包装:`handlers/websearch-results.ts:42-71`("REMINDER: You MUST include the sources...")。
- Grep/Glob 包装:`handlers/grep.ts:201-235`、`handlers/glob.ts:151-152`(截断提示)。
- ToolSearch 公告:`tool/search/exposure.ts:17-21, 146-208`(deferred 工具新增/移除公告)。
- Node REPL 回填:`handlers/node-repl-model-content.ts`(错误头+stack、`=> result`、"(no output)"、截图路径)。
- 执行器错误:`executor/call-runner.ts:164`、`executor/errors.ts:22`(`<tool_use_error>` 信封)。
- 能力缺失 guardrail(拒绝静默降级):`list-models.ts:51-58`、`resume-workflow-run.ts:74-80`、`resolve-workflow-question.ts:60-67`、`task-stop.ts:15-16`。
- Skill 内容包装:`handlers/skill.ts:80-90`(`<skill_content>` 包裹+base directory+截断标记)。
- `handlers/generated/bash-command-registry.ts`(约 1.8MB,由 `@withfig/autocomplete` 生成)是只读判定数据表,**不含**提示词文本。

---

## 4. 子代理提示词(core/src/subagent/)

子代理不走主 builder,由 `subagent/context-builder.ts:111-168` 装配:CLI prefix → agent prompt → Notes → Environment → 用户指令 → 当前日期 → skills。

| 文件:行 | 提示词 | 概要 | 篇幅 |
|---|---|---|---|
| `explore.ts:20-68` | Explore 子代理系统提示 | 只读代码检索专员;禁止一切文件写/删/移/重定向;只准 find/grep(或 Glob/Grep)、Read、只读 Bash;快速并行调用、直接文本返回报告 | 约 33 行 |
| `general-purpose.ts:7-24` | general-purpose 子代理系统提示 | 完整完成任务不镀金;返回简洁报告供父代理转述;禁止主动创建 .md/README | 约 15 行 |
| `system-prompt.ts:10-19` | 子代理通用 Notes | cwd 每次重置须用绝对路径、回复给绝对路径、禁 emoji、工具调用前不用冒号、禁止写报告 .md | 约 7 行 |
| `system-prompt.ts:21-40` | 子代理环境段 `<env>` | 工作目录/git/平台/shell/OS + provider/model 一行 | 约 10 行 |
| `persistent-memory-prompt.ts:6-169` | 持久记忆系统提示 | 文件式记忆规范:四类记忆(user/feedback/project/reference)何时保存如何使用、不应保存的内容、frontmatter 格式与 MEMORY.md 索引规则(200 行/25KB 上限)、时效性核验、与 plan/task 边界。**core 内最长提示词之一** | 约 170 行 |
| `profile.ts:89-113` | 代理清单格式化 | `- name: description (Tools: ...)` 行,注入 Agent 工具描述/列表 | 每代理 1 行 |
| `listing.ts:6-70` | 代理列表增量通知 | "Available agent types..." / "New agent types..." / 并行提示(经 `agent_listing_delta` reminder 持久化) | 约 8 行 |
| `message-steering.ts:51-55` | coordinator steer 包装 | 摘要+空行+正文 | 格式化 |
| `completion-notification.ts:24-60` | 后台子代理完成通知 | `<task-notification>` + `Agent <type> task "<desc>" <status>.` | 短 |

---

## 5. 压缩(compact)提示词(core/src/compact/)

| 文件:行 | 提示词 | 概要 |
|---|---|---|
| `prompt.ts:1-12` | NO_TOOLS_PREAMBLE / TRAILER | 压缩请求的"禁止调用工具"夹板,要求纯文本输出 `<analysis>`+`<summary>` |
| `prompt.ts:14-109` | BASE_COMPACT_PROMPT(**最长提示词之一**) | 按时间序分析对话,产出 9 节结构化摘要(主要请求与意图/关键技术概念/文件与代码段/错误与修复/问题解决/全部用户消息/待办/当前工作/可选下一步),逐字保留安全相关约束,附输出示例 |
| `prompt.ts:111-131` | buildCompactPrompt / formatCompactSummary | 拼装(含自定义 Additional Instructions)与剥离 `<analysis>` 后处理 |
| `prompt.ts:133-165` | buildCompactSummaryMessage | 压缩后续接消息:"This session is being continued from a previous conversation...",可选附 transcript 路径、"近期消息保留原文"、"REPL VM 已清空"、"直接续做勿确认"后缀 |
| `microcompact.ts:12-13` | 微压缩占位符 | 旧工具结果替换为 `[Old tool result content cleared]` |

---

## 6. 记忆系统提示词(core/src/memory/)

| 文件:行 | 提示词 | 触发 | 概要 |
|---|---|---|---|
| `extraction.ts:42-66` | 记忆抽取子代理任务提示 | 每轮后判定需抽取时 | 只准用最近 N 条消息;工具限 Read/Grep/Glob/只读 Bash + 记忆目录内 Edit/Write/rm;两轮并行读写;无内容只回 "Nothing to save.";附现有记忆清单防重复 |
| `dream.ts:95-170` | "Dream" 记忆整理提示 | 距上次合并超 24h | 四阶段:定向(读目录/索引/主题文件)→ 从会话日志收集新信号(窄 grep)→ 合并写入(相对日期转绝对、删被证伪记忆)→ 修剪索引并与 CLAUDE.md 对账 |
| `memory-agent-loop.ts:279-298` | 记忆代理工具拒绝文案 | 循环中 | 只读 Bash 与记忆目录内 rm 才允许等三条 |
| `recall/selector.ts:15-22` | 记忆选择器系统提示 | 每个真实用户 query | 第一消息是记忆清单,每 query 最多选 5 个"确定有用"的文件名;不确定不选;user/project 类画像要保守;不重复选已召回。用户侧模板 `Select memories relevant to:\n<query>` / `Available memories:\n<manifest>` |
| `recall/manifest.ts:59-67` | 清单行格式 | — | `- [type] filename (ISO time): description` |
| `recall/content.ts:27-99` | 召回附件头/截断/陈旧标记 | 记忆注入当前轮 | "Retrieved for possible relevance — use only if it actually applies";截断与陈旧提示("N days old... verify against current code") |
| `index-content.ts:30-37` | 索引超限警告 | MEMORY.md 超限 | "keep index entries to one line under ~200 chars" |

---

## 7. 目标(goal)提示词(contracts/src/tools/target.ts + core runtime/methods/)

| 文件:行 | 提示词 | 概要 |
|---|---|---|
| `contracts/.../target.ts:116-134` | formatGoalStateForModel | 注入权威目标状态块(状态/用量/objective 以 `<untrusted_objective>` 包裹当数据) |
| `contracts/.../target.ts:137-194` | formatGoalContinuationPrompt | goal 自动续跑:继续推进 active goal、预算清单、避免重复、完成前逐项 audit(查真实证据、拒绝代理信号、不得自行标完成,runtime 会跑 verifier) |
| `contracts/.../target.ts:196-245` | formatGoalCompletionVerificationPrompt | 完成验证 sidecar(带全量历史、无工具):只验证不实现;返回 `{passed, reason, nextAction}`;reason/nextAction 用目标主语言;非任务型目标直接 pass;证据不足宁可 fail;todo 未清不得 pass |
| `contracts/.../target.ts:247-280` | 验证失败续跑提示 / 通过文案 | 失败:gap+续跑(包 system-reminder);通过:简短结果文本 |
| `core/.../runtime/methods/title-generation-sidecar.ts:60-79` | 会话标题生成 sidecar | 标题任务不是对话,严禁回答用户问题;用用户主语言、3-7 词、保留专名、只返回 `{"title":"..."}` JSON |
| `core/.../runtime/methods/workspace-generate-text.ts:27-28` | 连通性探测 | "You are ZCode connectivity probe." / "hi",输出限 1 token |
| `core/.../runtime/methods/turn-output-token-continuation.ts:12-13` | 输出截断续写 | "Output token limit hit. Resume directly — no apology, no recap..."(最多 3 次) |
| `core/.../runtime/methods/sample-model.ts` | MCP sampling 透传 | 提示词由 MCP App 提供,core 不注入自己的提示 |

---

## 8. 工作流提示词(core/src/runtime-task/ + workflow/ + bootstrap/)

### 8.1 通知与指引文案(core/src/runtime-task/)

| 文件:行 | 文案 | 概要 |
|---|---|---|
| `notification.ts:91-224` | formatTaskNotification | `<task-notification>` XML 骨架(local_agent/local_bash/local_workflow 三型,usage/reports/artifacts 节,120k 截断) |
| `notification.ts:235-331` | workflowDeliveryGuidance | 终态呈现指引:completed 按"结论→发现与证据→已验证/仅判断→未覆盖"交付;stopped 五种 stopReason 各写死下一步(用户停禁 resume;模型停引导 AmendWorkflow;provider 停先解决再 Resume 等) |
| `workflow-notification-copy.ts:16-97` | SYSTEM_NOTIFICATION_BANNER + provider 停止错误表 | "[SYSTEM NOTIFICATION - NOT USER INPUT]" 抬头;auth/quota/model_unavailable 等错误→两句话(什么错了+让用户做什么) |
| `workflow-notification-copy.ts:113-138` | 停滞通知 | run 20 分钟无成功请求:"仍在跑、无需你做任何事、勿自行取消/重建" |
| `workflow-notification-copy.ts:163-187` | escalate 通知 | 子代理升级阻塞问题,给 ResolveWorkflowQuestion 的逐字下一步;只有提问的那支停着 |
| `workflow-notification-copy.ts:208-247` | hole 通知 | 脚本留白:读草稿、只写语句、返回指定类型、调 FillWorkflowHole |
| `workflow-notification-copy.ts:291-372` | 空闲提醒 | 按 run 汇总仍开着的问题与留白;"需要用户就明说并结束轮次,勿瞎答让提醒停" |

### 8.2 expert/scheduler 阶段提示(core/src/workflow/)

| 文件:行 | 提示词 | 概要 |
|---|---|---|
| `expert/prompts.ts:13-52` | buildPhasePrompt | "正在运行 ZCode workflow phase: X"+runId/cwd/用户任务/调度参数/阶段目标/既有产物;要求 Markdown artifact 保留路径/命令/风险;seedGraph 阶段附 DAG JSON 契约(节点唯一、无环) |
| `expert/prompts.ts:54-89` | buildScheduledNodePrompt | 单节点版:"只执行本节点范围,返回变更、验证与剩余风险" |
| `expert/prompts.ts:91-155` | 阶段摘要/最终报告生成器 | 喂给后续阶段或用户呈现 |
| `scheduler/prompts.ts:8-36` | buildDefaultNodePrompt | 动态工作流节点提示(与 expert 节点版同构) |
| `scheduler/prompts.ts:38-73` | buildDefaultPlannerPrompt | 探索规划器:只返回固定形状 JSON(nodes/edges/exhausted/reasoning),无环 |

### 8.3 bootstrap 驱动层(apps/zcode-cli/packages/bootstrap/src/)

| 文件:行 | 提示词 | 概要 |
|---|---|---|
| `app/workflow-ask-epilogue.ts:20-39` | qualityEpilogue | 每条 dwf ask 的质量尾注:证据引用、检查须真实跑过、做不到照实说、被堵时 escalate |
| `app/workflow-driver-helpers.ts:127-128` | NUDGE_PROMPT | actor 回合结束未提交时催促"立即调用 submit_result" |
| `app/workflow-driver-helpers.ts:135-147` | schemaEpilogue | typed ask 尾注:用 submit_result 提交符合 JSON Schema 的结果 |
| `app/workflow-driver-helpers.ts:153-158` | TYPED_TOOL_EPILOGUE | mono 子代理对应短尾注 |
| `app/workflow-driver-helpers.ts:216-217` | TRANSIENT_CONTINUE_PROMPT | 瞬态失败后"从中断处继续" |
| `permission-options.ts:8-16` | 权限拒绝回填 | 用户拒绝权限时 tool_result 内容:"工具未执行,等待指示"(可附用户反馈) |
| `app/script-workflow-child-runtime.ts:118-138`、`app/create-app.ts:660-700` | 装配点 | 子代理 systemPrompt 继承/剥离与 persona 叠加(无字面量) |

---

## 9. 内置命令与自定义命令(bootstrap/ + cli/ + contracts/)

| 文件:行 | 提示词 | 概要 |
|---|---|---|
| `bootstrap/src/builtin-prompt-command.ts:80-126` | `/init` 命令提示 | 检查/创建工作区 AGENTS.md:目标路径、7 步流程、推荐内容清单、收尾摘要(约 45 行) |
| `bootstrap/src/builtin-workflow-command.ts:32-42` | `/workflow` 命令正文 | 用 dynamic-workflows skill 设计拓扑后写脚本并调 CreateWorkflow(禁 legacy Workflow/Agent) |
| `cli/src/command-center/slash-commands.ts:252-263` | `/skill <name> [task]` 提示 | 本轮先用 Skill 工具加载指定技能再执行,附 "User request:" 块 |
| `contracts/src/commands/index.ts:115-191` | 自定义命令展开框架 | "Run custom command /x. / Command source: …"、"User arguments:" 块、"Required skills: … 先调 Skill 工具" |

---

## 10. 技能与插件提示词(core 之外的 packages/)

### 10.1 bundled-skills(内置,工具会拒绝运行直到技能加载)

| 文件 | 篇幅 | 用途 |
|---|---|---|
| `bundled-skills/skills/dynamic-workflows/SKILL.md` | 1607 行/92KB(英文正文+中文注释) | CreateWorkflow 全部编写契约(拓扑选择、类型化结果、§16 facade) |
| `.../dynamic-workflows/patterns.md` / `examples.md` | 794 / 1110 行 | 编排形状目录 / 7 个完整示例 |

### 10.2 superpowers-plugin(纯 skills + hook)

- 会话注入 hook `hooks/session-start`(57 行 bash):把 using-superpowers/SKILL.md 全文以 `<EXTREMELY_IMPORTANT>You have superpowers...` 包裹注入会话。
- 14 个英文 SKILL.md:using-superpowers(117 行)、brainstorming(164)、writing-plans(152)、executing-plans(70)、requesting/receiving-code-review(103/213)、verification-before-completion(139)、test-driven-development(371)、systematic-debugging(296)、using-git-worktrees(215)、dispatching-parallel-agents(182)、subagent-driven-development(279)、finishing-a-development-branch(251)、writing-skills(655)。
- 子代理 prompt 模板(dispatch 时逐字进 Agent 工具 prompt 参数):`brainstorming/spec-document-reviewer-prompt.md`(49)、`writing-plans/plan-document-reviewer-prompt.md`(49)、`requesting-code-review/code-reviewer.md`(168)、`subagent-driven-development/{implementer(113), spec-reviewer(61), code-quality-reviewer(25)}-prompt.md`。

### 10.3 其他插件技能

| 插件 | 提示词 | 篇幅 |
|---|---|---|
| zcode-guide-plugin | 6 个 SKILL.md(configuration-guide 99 行;diagnosing-{hooks,commands,skills,mcp,plugins} 59-97 行) | 教模型配置与自诊断 |
| skill-creator-plugin | `skills/skill-creator/SKILL.md` | 159 行 |
| plugin-creator-plugin | `skills/plugin-creator/SKILL.md` + references/plugin-json-spec.md 等 | 58+68+68 行 |
| visualize-plugin | `skills/visualize/SKILL.md` + tweak.md + references/api.md + widgets/calendar.md | 281+62+128+90 行 |
| zcode-cua-plugin | `skills/computer-use/SKILL.md`(node_repl JS bootstrap + 每次调用规则) | 306 行 |
| documents-plugin | `skills/docx/SKILL.md`(315 行)+ references 8 份(design-system 1797 行等)+ routes 5 份 + scenes 7 份(多为中文正文)+ docx-viewer(41 行) | Office 文档生成 |
| pdf-plugin | `skills/pdf/SKILL.md`(1004 行)+ briefs 9 份(中文)+ typesetting 9 份 + pdf-viewer(35 行) | |
| presentations-plugin | `skills/pptx/SKILL.md`(783 行)+ pptx-viewer(41 行) | |
| spreadsheets-plugin | `skills/xlsx/SKILL.md`(349 行)+ scenes 10 份(中文)+ engines 4 份 + quality/pipeline.md(214 行)+ xlsx-viewer(44 行) | |
| Office 四插件共享 | `agents/visual-judge.md` ×4(内容一致):"You are the visual acceptance reviewer...",按格式分列验收标准,输出每页 pass/fail JSON;frontmatter 指定 GLM-5.3-Flash、tools [Read, Bash] | 各 48 行 |
| image-search-plugin | 仅远端 MCP 注册,无本地提示词 | — |
| browser-use-plugin | skill 由构建产出,仓库内无源 md | — |

### 10.4 office-runtime / 模拟器插件(模型可见工具描述)

- `office-runtime/src/wording.ts`(88 行,"Model-facing wording"):按插件裁剪的格式名词(FILE_NOUN/EXAMPLE_ANCHORS/READ_FORMS 等)。
- `office-runtime/src/adapters/server.ts`:MCP 工具描述集中在 L170(open_document)、L192(read_document 分页)、L221(anchor schema)、L251(point_at)、L278(see what user is looking at)、L355-431(导入/列文件);L62-68 `describeDocument` 生成文档大纲摘要。
- `android-emulator-plugin/src/mcp/server.ts`(369 行,23 个工具英文描述:build/设备/AVD/启停/截图/日志/UI)。
- `ios-simulator-plugin/src/mcp/server.ts`(376 行,20 个工具英文描述)。
- `dynamic-workflow`/`dynamic-workflow-runtime`:persona/systemPrompt 与 hole prompt(`dynamic-workflow-runtime/src/child-source.ts:146` 的 `__hole(...)`)全部来自用户脚本,包内无字面提示词。

---

## 11. 其他零散模型可见文本

- `core/src/repl/node-repl-session.ts:435`:REPL 内核超时/中止重置时,错误信息追加 "kernel reset, all previous bindings were cleared; reinitialize browser/tab bindings before rerunning"。
- `contracts/src/tools/bash.ts:14-27` `BASH_DESCRIPTION_FIELD_PROMPT`:命令 description 字段写作规范。
- `contracts/src/tools/{agent,workflow,escalate,submit-result,webfetch,get-workflow-run}.ts`:对应工具参数描述。

---

## 12. 统计与要点

- **语言**:发给模型的提示词正文几乎全部为英文;中文仅出现在代码注释(不进上下文)和用户可变内容(Office scenes/briefs、AGENTS.md、persona、output style)。
- **篇幅 Top**:dynamic-workflows SKILL.md(1607 行)> pdf SKILL.md(1004)> presentations SKILL.md(783)≈ dynamic-workflows examples(1110)> persistent-memory-prompt(约 170 行)> BASE_COMPACT_PROMPT(约 95 行)≈ workflowDeliveryGuidance(约 90 行)> EnterPlanMode 描述(约 85 行)。
- **纯代码不产提示词的目录**:`context/{types,utils,index}.ts`、`permission/`、`errors/`、`agent/` 大部分(消息结构)、`i18n/`、`tui/`(纯 UI 文案)、`shared-types/`。
- **边界**:仓库根的 packages/desktop、web、ui、services、shared 属于桌面/Web 客户端,不含 kcode 运行时的模型提示词(其 prompt-* 文件均为输入框 UI 组件);`docs/prompt-enhance.md` 是设计文档,不是运行时提示词。
