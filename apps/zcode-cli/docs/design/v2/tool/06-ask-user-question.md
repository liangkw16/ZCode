# AskUserQuestion Tool

TUI 落地规划见 [AskUserQuestion TUI 规划](../tui-ask-user-question.md)。

## 定位

`AskUserQuestion` 在执行过程中向用户提出选择题，用于澄清需求、收集偏好或让用户做实现决策。

## 决策与未回答语义修订（2026-11-15，已实现）

本节约束新生成的 provider-visible 描述和结果说明；文案与结果格式化已实现，交互 schema 和权限不变。
目标是减少无必要的提问，同时保留真正依赖用户决策的边界。必要与可选由模型结合当前目标、
已有授权、代码事实和合理默认值判断，不新增问题必填字段或交互状态。

- **必要决策**：答案会实质改变下一步，且无法从用户指令、已批准方案、可调查事实或授权范围内的
  合理默认值确定。只暂停依赖该答案的动作；能够独立完成的调查、准备和验证继续。
- **可选澄清**：答案有助于优化结果，但已有合理默认值且不改变用户目标或授权范围。通常说明
  采用的默认值并继续，不为这类问题调用工具制造强制等待。用户明确要求参与选择时遵循其要求。
- 已有明确答案或用户已授权采用合理默认值时，不重复询问。缺少回复、跳过、等待超时和交互失败
  都不产生新的偏好、决策或授权；实际的拒绝和取消仍按现有结果处理。
- 工具收到空答案或部分答案后，只依据实际返回的答案推进；未答的必要决策保持未决，未答的
  可选项可使用授权范围内的合理默认值。不能把“使用最佳判断”解释为自行补齐授权。
- 澄清与计划批准继续分开：`AskUserQuestion` 不代替 `ExitPlanMode` 的既有审批，也不借此
  重新审批已经获准的方案或普通实现步骤。

所有者与入口保持现状：`packages/contracts/src/tools/ask-user-question.ts` 拥有 schema；
`packages/core/src/tool/handlers/ask-user-question.ts` 的 `metadata.description` 和
`formatAskUserQuestionModelContent` 分别拥有模型描述与结果说明；permission broker 和当前
TUI / app-server 适配器仍负责收集并回填实际答案。

```text
模型判断有必要提问 → AskUserQuestion → 现有 permission broker / UI
                                           │ 实际 answers / annotations
                                           ▼
                                  handler 校验并返回原有结果
                                           ▼
                            formatter → 既有投影 → 最终 provider 请求
                                           ▼
                       按实际答案与已有授权继续；必要未决依赖保持未决
```

本次不改变输入/输出 schema、权限、超时、事件顺序、存储、UI 或 Desktop continuous / 手机
replayable 语义；不实现后文规划的独立 `UserInteractionPort`，也不增加异步提问能力。
调用工具后的等待仍由现有交互链路承担；“独立工作继续”不承诺等待期间可并发执行工具。
已持久化的问答与结果说明原样恢复，只更新新生成的描述和结果文本。

后续验收使用既有 CLI 测试入口，覆盖 `ToolRegistry.toContracts()` 与结果投影后的最终
provider 请求，不能只断言源文件含某一句提示词：

| 场景                                     | 模型应获得的语义与行为边界                             |
| ---------------------------------------- | ------------------------------------------------------ |
| 有惯例默认值、已有批准方案或可从代码核实 | 直接继续或先调查，不重复提问，不额外审批               |
| 全部问题有答案                           | 只按实际答案和已有授权继续，不把答题扩展为其他操作授权 |
| 可选问题为空或部分未答                   | 可采用合理默认值继续，不把可选澄清变成强制暂停         |
| 必要决策为空或部分未答                   | 标明未决，仅依赖该决策的动作等待，独立工作继续         |
| 用户明确授权对未答问题采用合理默认值     | 在该授权范围内继续，不要求再批准同一默认选择           |
| 缺少 `answers`、拒绝、取消或交互失败     | 保持现有错误/交互结果，不伪造答案或批准                |
| Plan 模式与旧问答恢复                    | 不以 Ask 代替计划批准；历史结果不重写                  |

文本与投影回归只能证明合同已送达；是否减少无效提问、是否正确保留必要依赖，仍需用上述
场景进行真实模型对照评测，不在本批 spec 更新中声称已验证。

## 输入契约

`AskUserQuestion` 输入是严格对象：

| 字段          | 类型                        | 必填 | 说明                   |
| ------------- | --------------------------- | ---- | ---------------------- |
| `questions`   | `Question[]`                | 是   | 1 到 4 个问题          |
| `answers`     | `Record<string,string>`     | 否   | 权限组件回填的用户答案 |
| `annotations` | `Record<string,Annotation>` | 否   | 用户对选择的附加说明   |
| `metadata`    | object                      | 否   | 追踪来源，不展示给用户 |

`Question`：

| 字段          | 类型               | 必填 | 说明                               |
| ------------- | ------------------ | ---- | ---------------------------------- |
| `question`    | `string`           | 是   | 完整问题，应该清晰具体，以问号结尾 |
| `header`      | `string`           | 是   | 很短的 chip/tag，最大 12 字符      |
| `options`     | `QuestionOption[]` | 是   | 2 到 4 个选项                      |
| `multiSelect` | `boolean`          | 否   | 是否允许多选，默认 `false`         |

`QuestionOption`：

| 字段          | 类型     | 必填 | 说明                   |
| ------------- | -------- | ---- | ---------------------- |
| `label`       | `string` | 是   | 1 到 5 个词的显示文本  |
| `description` | `string` | 是   | 选项含义或取舍说明     |
| `preview`     | `string` | 否   | 聚焦该选项时展示的预览 |

输入还有唯一性约束：

- `question` 文本必须唯一。
- 同一个问题内 option label 必须唯一。
- 不应提供 `Other` 选项，UI 会自动提供。

## 输出契约

输出：

| 字段          | 类型                    | 说明                                         |
| ------------- | ----------------------- | -------------------------------------------- |
| `questions`   | `Question[]`            | 实际询问的问题                               |
| `answers`     | `Record<string,string>` | 用户答案，key 是问题文本，多选答案用逗号分隔 |
| `annotations` | optional record         | 选项 preview 和用户 notes                    |

模型可见结果区分完整、部分和空答案，不统一声称“用户已经回答”。每个实际答案按
`"question"="answer"` 序列化，并可附带 preview 和 notes；未答问题遵循上文的必要/可选决策语义。

`answers` 表达用户实际提供的答案，不表达表单必填约束：

- 全部回答时包含所有问题的 key。
- 部分回答时只包含已回答问题，未回答问题不写入空字符串。
- 用户主动提交但没有回答任何问题时使用空对象 `{}`；这不是新授权或偏好，后续依照已有信息和未决依赖处理。
- `answers` 字段完全缺失表示权限组件尚未完成交互，tool handler 不能提前执行。

## 行为语义

核心流程：

1. 模型提交 1 到 4 个问题和 2 到 4 个选项。
2. tool 通过 `requiresUserInteraction` / `needsApproval` 进入现有 permission broker，由交互适配器收集答案。
3. 用户在 UI 中选择任意数量的答案，可跳过部分或全部问题，也可输入 Other 或 notes。
4. 权限组件把 `answers` 和 `annotations` 回填到 updated input。
5. tool `call` 只回传问题和答案，不做外部 I/O。
6. tool result 进入模型上下文，agent 根据实际答案继续可执行工作，保留未回答的必要决策。

工具声明为：

- `readOnly: true`
- `concurrentSafe: true`
- `requiresUserInteraction: true`
- `needsApproval: true`

ZCode 应把 `requiresUserInteraction` 作为调度层一等能力：非交互 session、远程 channel 或后台 agent 不能直接卡住等待 TUI。

## Prompt 约束

provider-visible tool description 由现有 `metadata.description` 经工具合同投影提供，
本次不新增 `modelInstructions` 接口。描述与结果说明须一致，至少表达：

- 这是执行过程中向用户提问的工具。
- 仅在确实需要用户决定、无法从已有指令、代码事实或合理默认值确定时使用；可选澄清不应阻断工作。
- 空或部分答案不产生新的偏好、授权或必要决策；独立工作继续，必要未决依赖保持未决。
- 用户总能选 Other 输入自定义文本。
- 多选问题使用 `multiSelect: true`。
- 推荐选项放第一个，并在 label 后加 `(Recommended)`。
- plan mode 中只能用于计划定稿前澄清需求或选择方案；计划审批应走专用 plan
  approval flow/tool，不能用 `AskUserQuestion` 问“计划是否可以执行”。
- 不要在用户还看不到计划时引用「这个计划」。

ZCode 应把 plan approval 和 clarification 分开，避免 AskUserQuestion 被滥用成通用确认按钮。

## Preview 约束

preview 支持 markdown 或 HTML，取决于运行环境配置。

Markdown preview 可用于：

- UI mockup ASCII 草图。
- 代码片段。
- 图表变化。
- 配置例子。

HTML preview 可用于：

- HTML mockup。
- 格式化代码片段。
- 视觉对比或图表。

HTML preview 校验：

- 必须是 fragment，不能有 `<html>`、`<body>` 或 `<!DOCTYPE>`。
- 不能包含 `<script>` 或 `<style>`。
- 必须包含 HTML tag。

preview 只适合单选问题，不适合简单偏好问题或 multiSelect 问题。

实现核对（2026-05-08）：`packages/contracts/src/tools/ask-user-question.ts` 已在
`AskUserQuestionOptionSchema` 内执行 preview 校验。普通 markdown preview 原样通过；检测到
HTML / doctype / comment 形态时，runtime schema 要求它必须是 HTML fragment，拒绝
`<!DOCTYPE>`、`<html>`、`<body>`、`<script>`、`<style>`，并拒绝只有 HTML comment 而没有
可渲染 tag 的 preview。覆盖测试见 `packages/contracts/tests/ask-user-question.test.ts`。

## 权限和会话模型

`AskUserQuestion` 本质上是用户交互 tool，不是传统权限申请：

- 每一道题都允许不回答。桌面端的选项焦点只用于键盘导航，只有明确点击、空格或 Enter 选中才写入答案；直接点击“继续”或“提交”表示跳过当前题。
- Bot 单选菜单必须提供独立“跳过”操作；跳过中间题后继续下一题，跳过最后一题则提交当前部分答案，全部跳过时提交 `{ answers: {} }`。

- `requiresUserInteraction` / `needsApproval` 通过现有 permission broker 承载问答，不表示答案自动批准其他操作。
- 用户拒绝时需要产生明确的 rejected projection。
- 是否可用取决于当前交互适配器；远程 app-server 可承载问答，不能仅因用户不在 TUI 就禁用。无法承载交互时沿用现有不可用或错误路径。

ZCode 应将它实现为 `UserInteractionPort`：

- 支持 TUI、SDK、远程 channel 三种交互承载。
- pending prompt 必须是 session 状态，可恢复、可取消、可审计。
- 每个问题、选项、答案都必须归属当前 `traceId` 和 `turnId`。
- 非交互环境应直接禁用或返回结构化错误，不能无限等待。

## 校验与错误

关键失败路径：

- questions 数量不是 1 到 4。
- options 数量不是 2 到 4。
- question 重复。
- option label 重复。
- HTML preview 包含完整 document、script、style 或没有 HTML tag。
- 非交互环境无法显示问题。
- 用户拒绝回答。
- prompt 被取消或 session 恢复时找不到 pending prompt。

这些应区分为 schema error、preview validation error、interaction unavailable、user rejected、prompt cancelled。

## ZCode 设计结论

`AskUserQuestion` 是 NL-to-code 过程里的「需求澄清」接口。它不应该只是一个权限弹窗：

- contract 层定义 `QuestionSet`、`QuestionOption`、`UserAnswer`、`QuestionAnnotation` schema。
- core 层创建 pending interaction event。
- UI/SDK/channel 通过 interaction adapter 回填答案。
- tool result serialization 只把答案摘要交给模型。
- 计划审批、危险操作确认、普通偏好选择需要不同 capability，不能全部塞进一个 ask tool。

## 当前实现核对（2026-05-08）

已落地的 MVP 主线：

- contract 层已暴露 `AskUserQuestion` 的 runtime schema、JSON Schema、TypeScript
  类型、答案校验和 preview annotation schema。
- core 层已注册 `AskUserQuestion` 内置 tool，并把 `requiresUserInteraction`、只读、
  低风险、`userInteraction` side effect scope、timeout、cancellation、result budget
  和 runtime output schema 投影到 tool contract。
- permission/runtime 层已识别 `requiresUserInteraction`，不会把它当成普通自动 allow
  工具执行；当前仍通过 permission broker 的 `modify` result 回填答案。
- TUI 层已支持单选、多选、自动 Other 自定义文本、拒绝、取消、纯文本 preview、
  preview annotation 回填、多问题 review tab 和 composer draft 保留。
- ZCode app-server 层已通过 `zcode.dev/elicitation/create` 扩展承载 `AskUserQuestion`，并把
  elicitation response 转成 `modifiedInput.answers` / `annotations`。
- tool handler 只接受权限组件已经回填 `answers` 字段的输入；字段缺失时返回结构化可恢复
  tool execution failure。`answers` 可以是完整、部分或空对象，未回答问题不伪造偏好。

仍未完成的架构收口：

- 独立 `UserInteractionPort`、`pendingUserInteractions` session projection 和
  requested/answered/rejected/cancelled 事件尚未落地。
- session resume 后继续回答 pending question、SDK/HTTP/plugin list/reply/reject
  仍按后续阶段推进。
- TUI 对 markdown/html preview 只做纯文本展示；完整 HTML sandbox、富渲染、图片粘贴、
  plan interview 特殊按钮和 analytics 事件不在当前 MVP 内。

## MVP 开发范围

第一版先落地可恢复、可审计、不会被自动权限模式绕过的核心交互闭环：

- contract 层暴露 `AskUserQuestion` 的 runtime schema、JSON Schema 和 TypeScript 类型。
- core 层注册 `AskUserQuestion` 内置 tool，并把它投影给模型。
- permission/runtime 层识别 `requiresUserInteraction`，即使在 `yolo` 模式也必须进入交互 broker，不能自动 allow。
- TUI 层支持单选、多选、自动 Other 自定义文本、拒绝、取消、文本 preview、preview
  annotation 和多问题 review。
- tool handler 只接受权限组件已经回填 `answers` 字段的输入；字段缺失时返回结构化失败。
  用户可提交完整、部分或空答案；未回答问题不伪造偏好或授权，后续按上文必要/可选决策语义处理。
- markdown/html preview 字段作为契约字段透传；第一版 TUI 显示文本 preview，不做富渲染。

第一版暂不实现图片粘贴、plan interview 特殊按钮、完整 HTML preview sandbox 和 analytics 事件；这些能力必须沿用同一 `Question` / `Annotation` 契约逐步扩展。

最低测试集：

- 单选、多选、Other。
- 1 到 4 个问题边界。
- 选项数量边界。
- 重复问题和重复 label。
- markdown preview 和 HTML preview 校验。
- 用户拒绝。
- 部分回答和零回答。
- 非交互 session。
- session 恢复后继续回答 pending question。
