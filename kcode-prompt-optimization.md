# kcode 提示词优化建议(对标 Codex / Claude Code / DeepSeek DSH)

基于 [kcode-prompts-inventory.md](./kcode-prompts-inventory.md) 的提示词清单,对照三家业界实现提出优化建议。

- **Codex**:OpenAI 开源仓库 `github.com/openai/codex`(main,2026-10),提示词在 `codex-rs/core/*.md` 与 `codex-rs/prompts/templates/`。
- **Claude Code**:未开源,采用存档 `github.com/Piebald-AI/claude-code-system-prompts`(v2.1.306,2026-10-20)与完整抓取版交叉验证。
- **DeepSeek DSH**(DeepSeek Harness):开源 `github.com/deepseek-ai/deepseek-harness`(2026-08 发布),提示词即源码。

---

## 0. 总体结论(TL;DR)

1. **kcode 已大面与 Claude Code 2.x 最新片段同水位**:安全声明、Harness 块、沟通规范、自主性段落、注释规范、系统提醒语义等多段与 Claude Code 2026-10 版逐字或近逐字一致(`context/sections/identity.ts:9-30`、`context/dynamic-sections.ts`)。整体结构(stable/dynamic 缓存分离、meta_user 附件、工具结果信封、能力缺失 guardrail)也是业界主流,这些**不需要动**。
2. **主要差距集中在五处**:
   - compact 提示词仍是 1.x 旧范式(95 行、9 节、要求整段代码),落后于 Codex 的"交接"范式与 Claude 2.x 的固定段落结构;
   - 缺"防御性 Git/脏工作区"硬规则(不回滚用户改动、异常变更立即停、禁 destructive 命令)——这是 Codex 沉淀出的事故防御集;
   - 子代理委派缺"成本优先"框架与等待期反编造规则;
   - Todo/Plan 工具缺"度"的控制(何时不用、状态机不跳级、计划怎么写);
   - 权限拒绝与循环调用缺"报错即教程"(拒绝报文自带下一步、循环检测渐进提醒)。
3. **工程治理差距**:无模型分层提示词变体、无提示词快照回归、无 section 顺序预算与 fail-loud 校验、缺每段 token/缓存效应记录。

---

## 1. 保持项(已达水位,不建议动)

| kcode 现状 | 对标结论 |
|---|---|
| 安全声明 + Harness 块(`identity.ts:9-30`) | 与 Claude Code 2.x 当前版一致(授权语境制安全政策、权限被拒不重试、专用工具优先、`file_path:line_number`) |
| 沟通/自主性/注释规范(`dynamic-sections.ts:4-41`) | 已是 Claude Code 2.1.2xx-2.1.30x 最新片段(冷读自足、readable>concise、结尾自检反"光说不做"、"咨询 vs 施工"例外) |
| stable/dynamic cacheHint + meta_user 分离(`context/builder.ts`) | 与 DSH"静态 section 进缓存、易变事实走 user-role 快照"的 KV-cache 策略等价 |
| 工具结果信封(`<tool_use_error>`、`<persisted-output>`、Read 防重读 stub、Edit 成功回填) | 业界最佳实践水平 |
| 能力缺失 guardrail(拒绝静默降级,如 `list-models.ts:51-58`) | 三家中独有,保留 |
| `<system-reminder>` "非用户输入、不构成同意" 语义(`system-reminder/incoming-message.ts`) | 与 Claude Code 2.1.301 一致 |
| 通用工具协议(Read/Edit/Write/Grep/Glob 描述) | DSH 的观察印证:工具 schema 对齐已被模型充分训练的"公共协议"是正确策略,不要标新立异 |

**建议**:把"跟踪 Claude Code 片段库更新"机制化(见 P2-14),而非一次性搬运。

---

## 2. P0:纯文案改动,低风险高收益

### P0-1 重写 compact 提示词为"交接"范式

**现状**:`core/src/compact/prompt.ts:14-109`。95 行、9 节结构,1.x 风格:`full code snippets where applicable`、大段 example、`Double-check for technical accuracy` 之类的软要求。

**对标**:
- Codex(`prompts/templates/compact/prompt.md`)只有 9 行,定位是"写给下一个 LLM 的交接文档",必含 4 项:进度与决策/约束与偏好/剩余步骤/关键数据。恢复前缀:"Use this to build on the work that has already been done and **avoid duplicating work**."
- Claude Code 2.x 压缩前在 `<analysis>` 内要求"特别注意用户纠正过你的反馈",摘要用固定 5 段:Task Overview / Current State / **Important Discoveries(含"试过但不行的方案")** / Next Steps / **Context to Preserve(含"对用户做过的承诺")**,收尾:"err on the side of including information that would prevent duplicate work or repeated mistakes."

**建议**(保留 kcode 现有的 NO_TOOLS 夹板与"安全约束逐字保留"要求):
1. 节结构从 9 节收敛到 6 节,合并 2/3/5(概念/文件/问题解决),新增两节:
   - `Approaches tried and rejected`:试过但失败/被否的方案与原因——防压缩后重复踩坑,这是 kcode 目前完全缺失的;
   - `Promises and commitments made to the user`:已向用户承诺但未兑现的事。
2. `full code snippets` 改为 `key signatures and the important lines only — do not reproduce whole files or long blocks; the full transcript remains available`。压缩摘要里的整段代码是纯 token 成本,kcode 已有 `transcriptPath` 兜底机制(`prompt.ts:146-148`),让模型去读原文而不是在摘要里搬运。
3. 续接消息(`buildCompactSummaryMessage`)开头加一句:"Use this summary to build on the work already done and avoid duplicating it."
4. `All user messages` 节与"安全约束逐字保留"保留——这是 kcode 现有优点。

**收益**:压缩 token 成本下降、压缩后重复劳动减少。**风险**:低;`runtime-compact-telemetry.test.ts` 等既有测试需同步。

### P0-2 补防御性 Git/脏工作区规则

**现状**:`tool/handlers/bash-prompt.ts:18-21` 的 `# Git` 小节只有交互式 flag、gh、commit/push 纪律;`dynamic-sections.ts:86` 有通用的"删除/覆盖前先看目标",但没有 git 特化规则。

**对标**:Codex(`gpt-5.2-codex_prompt.md`)把事故防御写成硬规则并用大写强化:
> "You may be in a dirty git worktree. / NEVER revert existing changes you did not make unless explicitly requested… / While you are working, you might notice unexpected changes that you didn't make. If this happens, STOP IMMEDIATELY and ask the user how they would like to proceed. / NEVER use destructive commands like `git reset --hard` or `git checkout --` unless specifically requested or approved."

**建议**:在 `bash-prompt.ts` 的 `# Git` 小节追加(或做成独立 `# Git safety` 段,desktop 与 workflow actor 共用):

```
- You may be in a dirty worktree: NEVER revert or discard changes you did not make unless explicitly requested.
- If you notice unexpected changes you didn't make, stop and surface them to the user before continuing.
- Never use destructive commands (`git reset --hard`, `git checkout --`, `git clean -fd`) unless the user explicitly requested or approved them.
```

**收益**:堵住编码 agent 最常见的一类不可逆事故;与 kcode 现有"不可逆动作先确认"原则同向。**风险**:几乎无。

### P0-3 Agent 工具描述补"成本优先"框架与等待期反编造

**现状**:`tool/handlers/agent.ts:90-119`。已有何时委派/何时直查、"委派后别自己重做";异步路径已有"If the user asks for progress, say the agent is still running"(`agent.ts:157`)。

**对标**:Claude Code 2.x 的 Agent 工具描述先讲**双向信息损耗**再给规则:
> "A fresh agent costs more than it looks. It knows only what you put in the prompt, and you see only the summary it sends back — both handoffs drop detail… The user pays for agents you did not need, and pays again for work you redo because you skipped one."
> "- Do not fan out multiple subagents on a single small task… / - Do not spawn a subagent to review, re-verify, or double-check work you can verify inline."
> "Never fabricate or predict a pending agent's results — the notification is never something you write yourself."

**建议**:在 `## When to use` 前加一段成本框架;在 bullets 中追加:

```
A fresh agent costs more than it looks: it knows only what you put in the prompt, and you see only the summary it sends back — both handoffs drop detail. Do the work yourself when it is a handful of tool calls or a lookup whose target you already know. Don't fan out multiple agents on one small task, and don't spawn an agent to re-verify something you can check inline.
- Never fabricate or predict a pending agent's results — wait for the completion notification.
```

**收益**:抑制子代理滥用(成本)与等待期编造(正确性)。**风险**:低;注意与 `subagent/listing.ts` 的并行提示("独立任务应并行发出")不冲突——成本框架说的是"单个小事别拆",并行提示说的是"多个独立事别串行",可在文案里写清。

### P0-4 TodoWrite 补"何时不该用"+ 状态机规则

**现状**:`tool/handlers/todo.ts:138-142`,6 行,只有"全量替换、单 in_progress"。

**对标**:
- Codex:"Skip using the planning tool for straightforward tasks (roughly the easiest 25%). / Do not make single-step plans. / Do not jump an item from pending to completed: always set it to in_progress first. Do not batch-complete multiple items after the fact. Do not let the plan go stale while coding."
- Claude Code:7 组正反 few-shot + "NOTE that you should not use this tool if there is only one trivial task" + "Never mark a task as completed if: Tests are failing / Implementation is partial…"

**建议**:TodoWrite description 追加:

```
Skip the todo list for straightforward tasks — if there's only one trivial thing to do, just do it. Don't create single-step plans.
State transitions: set a task in_progress before starting it, mark it completed only when done (never pending → completed directly, never batch-complete after the fact). Never mark completed while tests are failing or the implementation is partial. Keep the list current — if priorities change, rewrite it before continuing.
```

**收益**:防止 todo 工具变成噪声(小任务建单条 todo、跳级完成、过期列表)。**风险**:无。

### P0-5 权限拒绝回填做成"报错即教程"

**现状**:`bootstrap/src/permission-options.ts:8-16`,拒绝时回填"工具未执行,等待指示"(可附用户反馈)。Harness 块里有"adjust, don't retry verbatim",但那是在 system prompt 里,拒绝发生的当场没有重申。

**对标**:DSH 的设计哲学——拒绝报文自带下一步:"a policy denial: do not retry another way"、escalation "retry the exact same command once with sandbox_permissions… a rejected escalation is final"。Codex 的 `on_request.md` 同理(提权协议写在拒绝语义里)。

**建议**:拒绝回填文案追加一句就地指引:

```
The user declined this call — do not retry it verbatim. If the underlying need remains, adjust: narrow the command, use a dedicated tool, or ask once with a specific alternative.
```

**收益**:被拒后模型最常见的两种坏行为(原样重试、绕道执行)当场被抑制,比远在 system prompt 里的规则有效。**风险**:低;与用户自定义拒绝反馈的拼接顺序需保持"用户反馈在前"。

### P0-6 Bash 增加可执行安全守则

**现状**:`bash-prompt.ts` 无删除/路径核验类守则。

**对标**:DSH bash 工具描述里的两条可操作守则:
> "Before any delete or move, verify that the resolved absolute target path is the intended one; never run it against a computed path you have not checked."
> "An unset variable expands to an empty string, so guard variables in such paths with `${VAR:?}`."

**建议**:bash description bullets 追加:

```
- Before any delete or move, verify the resolved absolute target path is the one you intend — never run it against a computed path you haven't checked. Guard path variables with ${VAR:?} so an unset variable fails instead of expanding to empty.
```

**收益**:`rm -rf "$DIR/"` 变量空展开是真实事故源,规则可执行、无歧义。**风险**:无。

---

## 3. P1:结构性优化

### P1-7 按模型分层维护两套系统提示(双轨制)

**对标**:Codex 最核心的工程决策——微调模型(`gpt-5.2-codex_prompt.md`,约 90 行)只留不可内化的约束(工具偏好、脏树保护、输出格式);通用模型(`gpt_5_1/2_prompt.md`,约 330 行)才需要人格/计划/few-shot 全套。Claude Code 2.x 也用"片段 + 条件函数"做变体(如 lean rewrite、effort 分级 fan-out)。

**kcode 现状**:单套提示词跑所有模型(GLM 与第三方通用模型同享 `identity` + `dynamic-sections` 全文),`bootstrap` 已有 compact `modelOverrides` 机制(见近期提交),说明分层基础设施存在。

**建议**:在 `ContextBuilderConfig` 增加模型档位(fine-tuned / general),general 走现状全文;fine-tuned 档裁掉人格化与沟通教学段(Dynamic Behavior 的叙事段落、Session Guidance),保留:安全声明、Harness、Context Management 的自主性段、环境/记忆/技能动态段、全部工具描述。先用遥测对比两档在 GLM 上的表现再推广。

**收益**:微调模型省系统提示 token、减少与内化行为冲突的冗余指令。**风险**:中;需 A/B 验证,建议按仓库规范先出 spec。

### P1-8 输出篇幅定量分级

**对标**:Codex `gpt_5_1_prompt.md` Verbosity 节把"be concise"变成可执行数字:
> "Tiny/small single-file change (≤ ~10 lines): 2–5 sentences or ≤3 bullets. No headings. / Medium: ≤6 bullets or 6–10 sentences. / Large/multi-file: Summarize per file with 1–2 bullets… / Never include 'before/after' pairs, full method bodies… Don't dump large files you've written; reference paths only."

**kcode 现状**:`dynamic-sections.ts:15-19` 只有定性规则("readable matters more"、"be selective")。

**建议**:在沟通段后追加一小节定量标尺(按小/中/大改动的句数与 bullet 上限、禁 before/after 对照、禁贴整个文件)。同时补 Codex 的同机假设一句:"The user is on the same machine — don't offer to save/copy files; reference paths."

**收益**:终态消息长度可预期,大改动汇报不再倾倒代码。**风险**:低。

### P1-9 循环调用渐进提醒(guard 家族)

**对标**:DSH `repeat-tool-reminder`:"Advisory, not veto",阈值 `[3,5,8]` 次精确重复(同工具同参数),第 3 次短提醒、第 5/8 次详细提醒(列出 tool+参数),新用户消息清零;以会话消息注入而非改 system prompt。

**kcode 现状**:system-reminder 30 种 source 中无循环检测;`turn-output-token-continuation` 有次数上限,但工具循环无防护。

**建议**:新增 `repeat_tool_call` reminder source + 计数器(精确参数匹配,新用户消息清零),文案两档照抄 DSH 结构:短版"Carefully analyze the previous result before calling again…";详细版列出 tool/consecutive_calls/arguments + "Do not call this tool with these exact arguments again"。

**收益**:直接治死循环烧 token;比在 system prompt 写"don't loop"有效(时机在事发现场)。**风险**:中;需要 runtime 改动,先出 spec。

### P1-10 Plan 工具:收紧"度" + 计划文档写作规范

**现状**:`tool/handlers/plan-mode-prompts.ts`。Enter 描述 7 类触发 + GOOD/BAD 例,但收尾是"If unsure, err on the side of planning"(鼓励侧);Exit 只讲何时用,不讲计划文本怎么写。

**对标**:
- Codex 反向控制"度":"Skip… roughly the easiest 25% / Do not make single-step plans",并对计划状态机有完整规则(不跳级、不事后批量完成、pivot 先改计划)。
- Claude Code 2.1.299 给出计划文档写作规范:"Begin with a **Context** section: explain why… / Include only your recommended approach, not all alternatives / Name the critical files… do not enumerate every file or line number / Include a verification section describing how to test end-to-end."

**建议**:
1. Enter 收尾从单边鼓励改为双向定量:"Skip it for the easiest tasks — single-file fixes, typo/small tweaks, or when the user gave specific detailed instructions. Don't enter plan mode for single-step work."
2. Exit 的 `## Before Using This Tool` 追加计划写作规范四条(Context 开头 / 只写推荐方案 / 点名关键文件不逐一枚举 / 以验证章节收尾)。

**收益**:plan 滥用(小事进 plan、计划写成文件清单)与计划质量同时改善。**风险**:低。

### P1-11 AGENTS.md 作用域与优先级成文

**对标**:Codex 把规则形式化:"The scope of an AGENTS.md file is the entire directory tree rooted at the folder… / More-deeply-nested AGENTS.md files take precedence… / Direct system/developer/user instructions take precedence over AGENTS.md instructions."

**kcode 现状**:`sections/request-user-context.ts` 有 "instructions OVERRIDE any default behavior" 声明,但未写明嵌套就近优先级。

**建议**:若支持嵌套 AGENTS.md,在注入头补两行就近优先与"直接指令 > AGENTS.md";若当前只收 workspace/user 两层,则注明"仅注入了这两层",避免模型自行假设深层文件存在。**收益**:规则冲突时行为可预期。**风险**:低。

### P1-12(可选)过程汇报示例句库

Codex 在 prompt 里直接给 8 条口语化 preamble 示例("I've explored the repo; now checking the API route definitions."),教语气与颗粒度(8-12 词)。kcode 沟通段已有定性要求("say in a sentence what you're about to do"),可补 2-3 条示例句锚定风格。**收益**:中;**风险**:无。

---

## 4. P2:工程治理

### P2-13 Section order 预算表 + fail-loud 组装校验

**对标**:DSH `SECTION_ORDERS` 编号总线(身份 -1000 / persona 0 / 策略 500-900 / 每工具一档 1000-3000 / 环境 10000+),新增能力"插队"不动他人段落;组装时未解析变量、重复 `complete` 段、非法 toolOrder **当场抛错**。

**kcode 现状**:`builder.ts` 按 push 顺序隐式排序,`addSection()` 扩展段无顺序约束,拼装无校验。

**建议**:给 `ContextSection` 增加 `order` 数值(集中一张表管理),插件段必须在声明区间内;装配时重名/越界 fail-loud。**收益**:提示词可组合性,防止未来插件乱序;**风险**:纯重构,需回归测试兜底。

### P2-14 提示词快照回归 + 版本化变更记录

**对标**:Claude Code 片段库每条标注引入版本 + 320 版 CHANGELOG;DSH 不变量 "Model-visible ⟺ logged"(凡进模型请求的输入必须可从 session log 重建),用 recorded-session snapshot 测提示词行为;Codex 有大量 prompt snapshot 测试与按 heading 剥离段落的程序化组装。

**kcode 现状**:已有 `tools/prompt-trajectory`、debug 包与分散的 context 相关测试,但无每 section 的 golden snapshot 与变更记录。

**建议**:①为每个 section/工具描述建 golden snapshot 测试,提示词改动必须显式更新快照;②在 `context/README.md` 维护 section 级 CHANGELOG(哪个版本改了哪段、为什么);③明确"模型可见 ⟺ 可回放"为团队不变量,新注入源必须有对应 reminder source 与 session 事件。**收益**:提示词变更可审查、可回滚、可归因。

### P2-15 每段 token/缓存效应文档化

**对标**:DSH 每个插件的 README 固定含 "Model Experience / What the model sees / **Token effect / KV Cache effect**" 四小节,并在 system-prompt README 量化缓存失效边界("any change invalidates reuse from the first changed token")。

**kcode 现状**:`ContextSection` 已带 `tokens` 估算与 `cacheHint`,但没有面向维护者的汇总文档。

**建议**:在 context 目录加一份 README,按 section 列出:注入条件、token 量级、stable/dynamic 及理由(参考本文档 inventory 表可直接生成)。**收益**:每次想往系统提示加东西时,成本可见。

### P2-16 工具面新增时的协议纪律

DSH 的实证观察:其 `str_replace_editor` 描述与 Claude 系几乎逐字一致——"工具面沿用已被模型充分训练的公共协议,创新集中在组装与治理层"。kcode 的 Read/Edit/Write/Grep/Glob 已对齐;建议作为规范固化:**通用文件/搜索/执行类工具的 schema 与描述不自造格式,自研工具(ReplyToChannel、workflow 族等)才自由发挥**。这样任何新模型接入时零再训练成本。

---

## 5. 落地顺序与验证

| 阶段 | 内容 | 验证方式 |
|---|---|---|
| 第一批(1-2 天) | P0-1~P0-6 全部文案改动 | 每条配单测断言新文案关键句;`pnpm typecheck` + `pnpm lint`;compact 改动跑既有 compact 测试 |
| 第二批(1-2 周) | P1-8、P1-10、P1-11、P1-12(纯文案);P1-7 出 spec 后灰度 | prompt-trajectory 抓取改前后完整请求做 diff 评审;遥测对比(子代理调用量、todo 使用率、终态消息长度) |
| 第三批 | P1-9(循环 guard,涉及 runtime)、P2-13~P2-16 | 按 AGENTS.md 规范:先更新 spec、架构检查、补测试;guard 类加 e2e 场景 |

注意:所有行为改动按仓库规范先补对应测试;P0-1(compact)与 P1-9(guard)涉及状态/时序,需要用图说明所有者与事件顺序。

---

## 附:三家调研的完整报告要点索引

- **Codex**:双轨提示词(90 行微调版 / 330 行通用版)、工具描述一句话+行为规范进 system prompt、权限模板化(approval_policy × sandbox_mode 正交注入、justification 必须问句、prefix_rule 黑名单)、脏树防御、plan 状态机+正反例、篇幅定量分级、compact 9 行交接、preamble 示例句库、AGENTS.md 优先级算法、prompt 按 heading 程序化剥离。
- **Claude Code**:片段+版本号+CHANGELOG 的提示词工程体系、因果解释式规则("结束回合=停止一切工作")、风险分级(可逆性×影响面)+一次性授权+破坏性动作禁当捷径、自主性分级拼装(交互/headless 共骨架换段落)、工具描述即政策(Bash 替代表、TodoWrite 7 组正反例)、子代理成本框架+等待期反编造、最终消息写作十条、注释零默认、compact 固定段落含失败尝试与用户承诺、plan 文档规范。
- **DSH**:SECTION_ORDERS 编号总线、静态/动态物理分离(KV-cache 优先)、工具描述三件套(行为契约+反模式+可执行守则+失败语义)、UI 需求进 schema(description 参数 required+few-shot)、报错即教程(沙箱拒绝自带升级协议)、循环防护 [3,5,8] 渐进 advisory、每工具一行系统指导、minimal 模式(一句话 persona+双工具)、plan 软硬分离、fail-loud 组装、"模型可见⟺可回放"不变量。
