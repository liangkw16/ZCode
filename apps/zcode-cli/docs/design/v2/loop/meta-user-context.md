# Meta User Context

## Silent-turn reminder

Main-session continuation requests check accepted history for a stretch without
user-visible communication. Five silent assistant responses since the latest
reminder trigger `silent_turn_reminder`; each stretch permits at most three
reminders. A response counts once regardless of its tool-call count. Reasoning-only
responses count as silent. Whitespace, `(no content)` and `No response requested.`
do not count as communication. Visible assistant text, AskUserQuestion or
ExitPlanMode calls, and a new user turn end the stretch. A user turn is an
ordinary user message in history: a real prompt, a new-turn `task_notification`
or `subagent_reply`, an interrupt marker, or a compact summary (the same rule
counts the turns of the plan reminder cadence). Tool results, output-token
recovery prompts, synthetic context and mid-turn inputs do not: a `user_steer` (including a
running "send now", which ZCode presents as a steer) or another `*_steer`
message continues the stretch, because mid-turn input is delivered as an
attachment. Subagent requests, the first request of a new turn, and
output-token recovery do not collect this reminder. The main-session default
uses these fixed thresholds for all supported models, without model-specific flags.

The runtime derives cadence only from canonical history. It persists the raw body
as a hidden runtime reminder (see "New dynamic entries" below) with
`runtimeMessage.source = silent_turn_reminder`, then commits the attachment.
Resume restores the same marker; compact/rewind use remaining history. There is
no timer or second counter. Persistence failures propagate before publication.
With MCS the notice projects as a mid-conversation system message;
without MCS it is a user-side `<system-reminder>`. Source metadata and the notice stay hidden from the App
transcript; desktop/mobile delivery contracts do not change.

```text
accepted history -> continuation collector -> persist notice -> commit attachment
                  -> provider reminder (MCS system / user) -> next model response
```

## Todo reminder cadence and formatting

Todo reminder cadence is derived from accepted message history, with no separate
counter. Assistant messages containing only reasoning blocks (including opaque
provider reasoning) do not advance either interval. A message containing text,
media, or a tool call still counts; TodoWrite still resets its own interval.
The existing thresholds remain ten assistant messages after TodoWrite and ten
after the last reminder. Resume uses the same history-based calculation.

The reminder paragraph ends with one newline. An empty list adds nothing; a
non-empty list adds two more newlines, the existing list heading, two newlines,
and numbered items inside brackets. Provider projection preserves this body for
both MCS and user-side reminder delivery.

## 虚拟 token 余额移除（2026-11-15，已实现）

本节替代原固定 15,000,000 token 倒数的生成与内存计数合同；新生成路径和专用计数器
已移除。该数值不代表 provider context 容量、真实账户余额或用户设置的执行预算，不能
用来宣称还能完成多少工作，也不应以虚拟余额耗尽作为停止任务的依据。

实现合同：

- 默认 system 不再追加 `<total_tokens>… tokens left</total_tokens>`，动态附件不再新建
  `total_tokens_reminder`。Main、普通子代理和 workflow 子运行时使用同一移除合同；custom
  system 不被自动补入余额，也不清洗用户自行提供的文字。
- 移除仅服务该虚拟余额的 runtime 内存计数与 reset、re-anchor、compact 累加逻辑，不以
  新计数器、持久化字段、配置或其他名称的虚拟额度替代。
- 保留真实 provider usage、费用统计、context 水位、本地估算 fallback、auto/reactive
  compact 和显式资源限制。虚拟余额移除不改变用户输入、queue/guide、通知、Stop、
  恢复或权限语义；不新增一条“额度无限”提示。
- 其他附件仍由既有 collector 按原触发点收集；仅撤销该来源的新内容生成。摘要不得把
  历史余额提升为新的资源事实，摘要的内容取舍见
  [任务接续摘要修订](../rewind-compact.md#任务接续摘要修订2026-11-15已实现)。

### 所有者与升级兼容

默认文本由既有 ContextBuilder/system section 生成，动态附件由既有 runtime attachment
collector 生成；usage 和 compact 沿用各自所有者。SessionStore 与 prompt snapshot 继续
保存、恢复历史内容，provider projection 继续解释原 source 和角色，不建立平行状态。

已经持久化的 `total_tokens_reminder`、已有摘要以及带旧余额的 prompt snapshot 不修改、
不删除、不迁移。恢复旧会话时，同模型快照仍可能保留旧 system；原文保留段和历史提醒
仍可经 MCS 或非 MCS 路径送入请求，字节与顺序沿用既有合同。新内容在既有 snapshot
更新或 compact 流程之后生效，但 compact 仍可能原样保留旧提醒，因此**不承诺升级后的
所有请求立即不含旧余额**。移除的是新生成路径，不是对历史请求的清洗。

### 验收

以下为验收要求；实际执行范围以验证报告为准：

- 新会话、无旧快照的 Main、子代理、workflow/default 与 custom-system 路径，不再由
  runtime 生成虚拟余额；custom 原文含相同字样时不得误删。
- 覆盖 `turn_input`、`tool_batch`、`text_guide`、goal/通知续行及各种请求重试，均不增加
  新余额提醒。busy/running 用户输入和 guide 的 admission、投递顺序与次数不变。
- 有旧快照与已持久化提醒的会话经冷恢复、rewind、fork、idle release 后恢复，历史字节
  不变且不追加新余额；由既有流程替换 snapshot 后，新生成 system 不含 runtime 余额。
- manual、auto、reactive compact 及连续多次 compact 不生成新余额或新内存累计；历史
  提醒位于保留段时原文仍在，位于被总结区时不作为资源事实写入新摘要。
- MCS 开/关、Anthropic 工具结果折叠与 OpenAI-compatible 独立 user reminder 路径检查
  最终 provider 请求：区别“没有新提醒”和“存在历史提醒”，其余提醒角色与顺序不变。
- 真实 usage、context threshold、context-exceeded recovery 与显式资源限制的原有行为
  仍成立；不能仅凭 `<total_tokens>` 字符串消失就判定验收通过。

## Ownership and assembly

ContextBuilder renders resolved snapshots; it performs no host IO. Stable and
behavior system sections remain in the initial system blocks; the context
prefix now holds only those system messages. Instruction files and the Memory
index retain the `context_prefix` source name, but are delivered as a dynamic
announcement like every other row below.

```text
instruction files + Memory index -> context_prefix -> user reminder
Git snapshot                     -> session_context -> user reminder
current environment              -> environment    -> MCS or user reminder
executing Model                  -> model          -> MCS or user reminder
current date                     -> date           -> MCS or user reminder
skill catalog                    -> skills_listing -> MCS or user reminder
```

`context_prefix` starts directly with the instruction preamble. It has no
`# agentsMd`, context intro, date section, or account/workspace footer. User
instruction labels say `user's private global instructions for all projects`;
workspace labels say `project instructions, checked into the codebase`.
The Memory index retains its existing auto-memory label and cleaning policy.

`session_context` currently supports only `gitStatus`. It renders the context
intro, `# gitStatus`, the initial snapshot, and the product-neutral ZCode
attachment notice without indentation. Git is decided once per context window
(the history since the session start or since the last compaction), and the
decision looks only at history. Before a model request: history already holds a
`session_context` → reuse it, read nothing (a directory change does not re-read
Git; a restored announcement wins over a newly constructed snapshot); history
already holds a `date` announcement → the window has decided, read nothing (the
window's first request places its request announcements, `date` included, in
one batch right after the decision), also when that decision announced no Git and
the directory has since become, or moved into, a repository; otherwise this is
the window's first request → read Git for the current working directory through
`ContextSourcePort.resolveGitContext` and announce it when the directory is a
repository. A cold resume continues the restored window, so it reads nothing
either; a repository created in the meantime shows up in the environment notice,
and its Git snapshot comes with the next window. Compaction with a non-empty kept
tail decides for the compacted history: the kept tail holds a `session_context` →
reuse it; otherwise read. Outside a repository nothing is announced.
Repository membership is a file system fact: the adapter walks from the
directory's real path (symlinks and junctions resolved, the location git itself
runs in) up to the file system root and looks for a `.git` entry, either a
directory or a file (the gitdir pointer of a worktree or submodule); a symlink
counts when its target exists. When the real path cannot be resolved (for
example a deleted directory), the walk starts from the path as given. It starts
no git process, so the answer is always
definite: `GIT_DIR` / `GIT_WORK_TREE` do not change it, and a hung or missing git
does not turn a repository into a non-repository. The project root (AGENTS.md
lookup, Project Context) comes from the same walk over the path as given, so
instruction file paths keep the path the user opened. When the real path equals
the given path, context initialization walks once and the found directory
serves both. They differ only for a link that points into a repository's
subdirectory (a repository, no project root) or a link inside a repository that
points outside it (not a repository, project root found). The runtime remembers a
directory as "not a repository" for its lifetime (a cold resume starts a new
runtime); a later decision in a remembered directory (compaction, or the first
request after a compaction that kept nothing) reads nothing. Inside a repository the snapshot commands run
in parallel, each with the 3 s timeout and the request's abort signal. Status is
`--no-optional-locks status --short --ignore-submodules=dirty`. Every automatic git command
is hardened the same way:

- The executable is `git` looked up on the process `PATH` with the rules Node uses for a
  bare program name, except the working directory: relative entries resolve against the
  process directory (skipped when it cannot be read, for example after it was deleted;
  absolute entries are still searched), empty entries are skipped; on Windows the value is split at `;`,
  surrounding double quotes are removed (the same split as the Bash tool), and each directory
  is tried with `.com`, then `.exe` (`PATHEXT` is not read). The lookup does not add the working directory the way Windows does
  for a bare program name, so a `git.exe` in the project does not run. The found path is kept for the process; when nothing is found the
  commands fail like a missing git and the next read looks again. Fix reason (2026-10-26):
  the lookup kept the quotes of an entry such as `"C:\Program Files\Git\cmd"`, so git was not
  found and the snapshot showed default values; it also skipped git when `PATHEXT` did not list
  `.EXE`, which Node does not do; and it read the process directory before any entry, so a
  deleted process directory hid a git on an absolute entry.
- The arguments start with `-c` overrides: `core.fsmonitor=`, `core.hooksPath=` the null
  device (`/dev/null`, `\\.\NUL` on Windows), `core.askPass=`, `protocol.ext.allow=never`,
  `submodule.recurse=false`, `log.showSignature=false`, `format.pretty=medium`, `gc.auto=0`,
  `maintenance.auto=false` and `hook.<name>.enabled=false` for each git hook name. The same
  pairs are repeated as `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`.
- The environment is the process environment without the inherited repository and config
  selectors (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`,
  `GIT_CEILING_DIRECTORIES`, `GIT_DISCOVERY_ACROSS_FILESYSTEM`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_SHALLOW_FILE`, `GIT_NAMESPACE`,
  `GIT_IMPLICIT_WORK_TREE`, `GIT_REFERENCE_BACKEND`, `GIT_CONFIG`, `GIT_CONFIG_COUNT`,
  `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_KEY_<n>`,
  `GIT_CONFIG_VALUE_<n>`, any letter case). It sets `GIT_ALLOW_PROTOCOL=/`,
  `GIT_CONFIG_PARAMETERS` (`'alias.remote-none=version' 'alias.remote-none.command=version'
'alias.remote-/.command=version' 'fetch.bundleURI=' 'help.autocorrect=0'`),
  `GIT_NO_LAZY_FETCH=1`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_TERMINAL_PROMPT=0`,
  `GIT_LFS_SKIP_SMUDGE=1`, `GIT_SSH_COMMAND=false` and `GIT_PROXY_COMMAND` (empty unless
  already set). `PATH` keeps only absolute entries: on macOS and Linux the variable named
  exactly `PATH` is split by `:` and keeps the entries that start with `/`; on Windows the
  variable of any letter case is split with the same rule as the lookup, and it keeps the
  entries with a drive letter or a UNC prefix. When none is left it is the null device.
  Fix reason (2026-10-26): on Windows the desktop host starts the Agent with the key in upper
  case, and the `:` / `/` rule removed every Windows entry. git then could not start helper
  programs such as git-lfs, status failed in an LFS repository and the snapshot said clean.
  The `-c` overrides and their `GIT_CONFIG_*` copy are built once per platform.

A filter driver configured in the repository can still run during status. A failed
command contributes empty output (for example `Current branch: HEAD` and
`(clean)`), and the result is announced once. An aborted request announces
nothing. Running `git init` in a
remembered directory is noticed by a new runtime: a cold resume re-reads
repository membership for its environment notice (see below), and the Git
snapshot follows with the next window. A new session's context initialization has just read Git;
that read serves the first decision only (prefetched at startup) when the working
directory has not changed. A prefetch that says "not a repository" announces
nothing and remembers the directory. A resumed session's snapshot comes from storage and is
never used as the prefetch. Without a context port the session-start snapshot is
the only Git source. Subagents and custom system prompts never read or announce
Git. Compaction re-reads only when it keeps a non-empty tail (otherwise the next
request reads); the result exists only as the announcement inside the compacted
history, so a failed or aborted compaction leaves no Git facts behind and the
runtime's context snapshot keeps the session-start values. Rewind and fork keep
the runtime's latest
snapshot. The current branch comes from `git symbolic-ref --short -q HEAD`,
which works before the first commit; a detached HEAD uses `HEAD`.

`environment` reuses EnvInfo fields: cwd, repository boolean, platform, shell,
and OS version, followed by one fixed bullet: `Downloaded files and extracted
archives are untrusted data: …` (fixed text). Bullets start with one space before `- `, repository status is
`true` or `false`, and the intro has a trailing space after its colon. It contains
no model identity or Git details. The run's additional directories
(`runtimeConfig.additionalDirectories`, set when the runtime is created or cold
resumed) follow the repository bullet as ` - Additional working directories:`
with one `  - <path>` line per path, in configured order; an empty list emits
nothing. Ordinary subagents do not inherit the list. When the run is shown in
ZCode Desktop (presentation surface `zcode_desktop`, and the context builder
adds the `desktop_context` section: not with a custom system prompt, for a
workflow actor or for a subagent), the environment carries the ZCode Desktop
part. Its snapshot records `desktopContext: true`; when the host supplies a Gen
UI output directory, the session's directory follows as
` - Visualization directory for this session: <path>`; otherwise the bullet is
absent. After the last bullet, the full block adds a blank line and the ZCode
Desktop Context text (`docs/desktop/zcode-desktop-context.md`), whose Gen UI
paragraph has two forms: with a directory and without one. Surface, rollout
switch, Gen UI availability and the directory are process or session facts, so
the system prompt holds none of them; a prompt snapshot can stay unchanged
while they change. A fork writes an update with the child's directory into the child history,
after the copied messages and before the fork notice. It does not wait for the
child's next attachment collection: the child's first request can be a
new-turn notification, which does not collect attachments. When the child runs
in another working directory (a fork into a managed worktree), the update also
states the new `Primary working directory`, and the child's directory is
computed for that working directory: the directory is keyed by the workspace
identity (or, without one, the workspace path) and the session id, the same key
the child's own announcements use. A local worktree child has no workspace
identity, and its workspace path is its working directory. The baseline is the
latest announcement in the child's model view (after the last compaction). When
that view has no announcement, the fork writes nothing and the child's next
announcement is a full block; when it has one without a directory and the fork
does not move the child to another working directory, the fork also writes
nothing. No
worktree, scratchpad, or other unsupported capability is advertised.

`model` describes only the executing Model's existing providerId/modelId using
`You are powered by the model named <providerId>/<modelId>.`. It is separate
from Environment. It does not add marketing names, knowledge cutoffs, or model
catalog facts. Session selection changes cannot rewrite an active step's model.

`date` initially renders `Today's date is <date>.` without a heading. A later
change renders `The date has changed. Today's date is now <date>. No need to
announce the new date — the user's own clock shows it.`

## Dynamic history

Two collectors own dynamic announcements: attachment collection and
per-request context announcements. Both read the
canonical history, append missing or changed context, and reuse the existing
provider projection. No independent announced-state cache is maintained.

The layout below reflects the pending removal of newly generated virtual-token
reminders described above. Other collection points and ordering are unchanged;
restored legacy reminders still use the existing projection.

```text
loop iteration (one model request)
  drain mid-turn steers                      (human guides first, then notifications and agent
                                              messages; only with new input: after a tool batch
                                              or a text-only guide drain)
  input attachments   environment -> model -> output_style_instructions
                      -> tool_search_announcement
                      -> agent_listing_delta -> skills_listing -> plan_mode_exit
                      -> runtime_mode -> todo_reminder
                      -> silent_turn_reminder
                      -> output_style -> memory_update
                      -> hook_context (UserPromptSubmit, first collection of the turn only)
  settled project-memory recall              (memory prefetch after attachments)
  microcompact / auto-compact
  request announcements   context_prefix -> session_context -> date
  provider projection -> request
```

Input attachments are collected before compaction, and only at three points:
the first request for the turn input, the first request after a completed tool
batch (this includes tool results that stream recovery or model fallback
settles), and the first request after a text-only reply drains a guide. The
loop state records which of the three points requested the collection
(`turn_input`, `tool_batch`, `text_guide`). Items
produced for the turn input or the last tool batch therefore belong to the
history that compaction keeps or summarizes. The other loop iterations send the
same input again and do not collect: Stop hook continuation, model fallback,
stream recovery without settled tool results, Start Plan admission wait,
context-exceeded recovery, off-peak request replacement and output-token
recovery. `silent_turn_reminder` is only collected after a model step.
`output_style` is produced on every collection without deduplication and
persisted, so a resumed session keeps the same prefix.
`output_style_instructions` carries the active output style text, which is not
in the system prompt. It is collected for the main thread only, under the same
gate as environment and model. The body is `# Output Style: <name>\n<prompt>`
(prompt trimmed; a whitespace-only prompt means no style). It is announced when
it differs from the latest `output_style_instructions` entry in history. When
the style is cleared and the latest entry is a style, the reset text
`The output style was reset to the default. Respond in your usual style.` is
announced once. Compaction restates the latest entry after environment and
model when the kept tail has none; a reset is not restated. Only the identity
line of the system prompt still depends on whether a style is active.
`read_truncation_notice` is not an input attachment: the tool batch writes it
right after its tool results when a Read returns a partial view, also when Stop
interrupts the batch's file checkpoint (before the interrupt marker).
`tool_hook_context` is not an input attachment either: the same tool batch
writes one entry per tool hook additional context
(`<Event>:<ToolName> hook additional context: <context>`) after its tool
results and before `read_truncation_notice`, grouped per tool in tool result
order.
`plan_mode_exit` is derived from history: outside plan mode it is announced when
the latest `runtime_mode` / `plan_mode_exit` entry is a `runtime_mode`; the
in-memory exit flag set on leaving plan mode is an extra trigger.
The ToolSearch announcement is the deferred-tools delta and sits (after model, before the agent listing); its body, delta
metadata and persistence follow [ToolSearch](../tool/19-tool-search.md).
Each item keeps its own persistence. The `UserPromptSubmit` hook context is the
last item of the first collection of a turn (the hook ran before the input was
written); later collections of the same turn do not repeat it. Event-time
attachments (rewind, goal changes, resume, compact, SessionStart and
Stop hook context, tool warnings, prompt attachments) are not part of either
collector. Lifecycle hook context rules are in
[hooks](../hooks.md) ("生命周期 Hook 上下文的持久化").

Request announcements run before every model request, after compaction,
including output-token recovery. Each source is announced when history has no
entry of that source, or, for `date`, when the latest one differs from the
runtime clock. They are never skipped.

On the first request of a turn whose input is a new-turn `task_notification`
or `subagent_reply`, all input attachments are skipped. The rule is derived from
history: the latest non-attachment entry is that input. Request announcements
still run, and projection bubbles them before the notification. Skipped items
are not lost: the Dream update stays pending and the other items are derived
again at the next collection point. Mid-turn `*_steer` inputs and the child task
(`coordinator_input`) do not skip collection.

With MCS, user-side `context_prefix` and `session_context` stay before the
prompt and one system message at the end of the user run holds the rest.
Without MCS, every reminder stays before the prompt in generation order.
Provider projection ends the user text right before a user input message with
one newline, as adjacent user messages are merged.

On the Anthropic Messages protocol, user-side reminders that directly follow a
tool result fold into the content of the last tool result in that run. The adapter declares this with the model request capability
`foldRemindersIntoToolResults`; OpenAI-compatible protocols do not declare it
and keep each reminder as its own user message, so a function output never
carries harness text. MCS does not change the rule, it only leaves fewer
user-side reminders. A string result becomes
`[result.trim(), reminder.trim()].filter(Boolean).join("\n\n")`. An array
result gets one `\n` on its last text block, then the reminder text blocks are
appended without trim. The fold stops at the first item that does not fold.
Mid-turn inputs are attachments and fold too, so without MCS a steer sits in
the tool result it arrived with. With MCS, a text-only steer goes into the
run's system message like the other mid-turn inputs. Real or presented user
inputs, reminders with non-text blocks (a steer with media too, with or
without MCS), and the MCS fallback reminder do not fold; a result that holds `tool_reference` blocks does not take
reminders. A tool batch followed by a native ToolSearch `Tool loaded.` notice takes no
reminders either: the notice is inserted before the fold, so the reminders follow it.
A folded steer is no longer the latest real user message for the
media budget. Token estimation and microcompact project without the fold.
Canonical history does not change.

Environment announcements persist a validated structured snapshot and whether
the notice is a full block or an update. The latest accepted history entry is
the comparison baseline; there is no second runtime cache. On a directory
change, the required `ContextSourcePort.resolveEnvironment` reads current
environment facts without reloading instructions, skills or the session-start
Git details; there is no fallback to full context resolution. A runtime restored
from the store (cold resume) did not read the stored facts itself, so its first
environment notice re-reads them through `resolveEnvironment` once, also when the
directory is unchanged. From that read it takes only the repository boolean;
platform and OS version keep the history values. A difference is
announced as an update. A live runtime does not re-read an unchanged directory.
The shell is the display name of the runtime's Bash shell selection when it has
one. New and cold-resumed runtimes read the current shell setting, so a shell
changed between runtimes is announced like a directory change; a live runtime
keeps its selection
([Bash Effective Shell Snapshot](../../../../../../docs/runtime-tools/bash-effective-shell-snapshot.md)).
A config-only
runtime without a context port can update cwd/shell only; host facts remain
supplied by its configuration. The cwd and shell are read once before the IO,
and the notice uses that pair with the facts read for it, so the notice is
always self-consistent. If the cwd or shell changes during the IO, there is no
retry: the next request compares the latest announcement with the current
state and announces the change then.

The first notice is `# Environment`. With a full block still present in active
history and unchanged platform and OS version, changes to cwd, the
repository boolean and the shell use `# Environment update` and only changed bullets:
` - Primary working directory: <new> (was <old>)` and
` - Is a git repository: <new> (was <old>)`. Additional-directory changes add
` - Additional working directories added:` and
` - Additional working directories removed:`, each followed by its `  - <path>`
lines. A changed visualization directory adds
` - Visualization directory for this session: <new> (was <old>)`; a new one
(older metadata has none) adds ` - Visualization directory for this session: <new>`,
and a removed one adds ` - Visualization directory for this session: none (was <old>)`.
A changed shell adds ` - Shell: <new> (was <old>)`; when the previous shell is
empty (older Windows sessions), it adds ` - Shell: <new>`.
Order is cwd, repository, directories, the visualization directory, then the shell.
The ZCode Desktop part is compared by its form: none, with a Gen UI directory,
or without one; older metadata has no `desktopContext` and counts as none. A
changed form is added after the bullets, with a blank line between: the whole
ZCode Desktop Context text in the new form or, when the run is no longer shown
in ZCode Desktop,
`The ZCode Desktop Context above no longer applies: this session is not shown in ZCode Desktop.`
When only the Desktop part changed, the update is that text alone, without the
`# Environment update` heading. A fork that changes only the directory keeps
the form. Returning to an earlier directory
compares against the latest announcement, not the initial environment.
Platform/OS changes require a new full block. Missing, malformed or
legacy snapshot metadata, or a history with only updates after compaction,
also requires a full block. Unchanged snapshots emit nothing. Snapshot
metadata is cloned and validated on restoration and never sent to providers.
Model changes append the current identity.
The Skill listing is announced once, when history has no `skills_listing`
entry and the catalog is not empty; compaction makes the same check against
the kept tail and places the listing after the agent listing. A change is
never announced as a new entry. Skills are discovered only when a runtime
starts, so the catalog can change only between runtimes. Each time history is
loaded from the store (cold resume, rewind), the restored `skills_listing`
entries are updated in place to the current catalog: changed content replaces
the old content at the same position, and an empty catalog removes them. The
update is in memory only. The stored record keeps its first content and fixes
only the position, and every load applies the update again. A changed catalog
therefore changes earlier request bytes once (one prompt-cache miss); an
unchanged catalog changes nothing. There is no per-skill delta.
`context_prefix` is never rewritten after it is sent. Changes are announced by
appending a new `context_prefix` entry (an instruction delta), so the request
prefix stays byte-stable across cold resume, rewind and later requests.

- **When files are read.** The runtime reads the instruction files and the
  Memory index when it starts (new session, cold resume) and again at the end
  of each compaction. It does not read them between those points; an edit in
  the middle of a runtime is announced only after the next compaction or by
  the next runtime. Rewind does not read them again. The compaction re-read is
  adopted only when the compaction commits; a failed or cancelled compaction
  leaves the held content unchanged.
- **Read errors.** A file counts as removed only when it is missing. For an
  instruction file that is not found, a directory or not a regular file, or a
  path segment that is not a directory. For the Memory index, the file system
  port codes `not_found`, `is_directory` and `not_file`; the port reports a path
  segment that is not a directory as `io_error`, so for the Memory index that
  case is unreadable. Any other read error (permission denied, busy, I/O error) makes
  the file unreadable; it is not a removal, and the runtime logs a warning
  (`context.instructions.read_failed`). A path whose existence check fails
  with such an error is still the candidate; the search does not go on to a
  parent directory. At a runtime start an unreadable path is never listed in
  `removed`, so the model keeps the copy it was told; the other files are
  compared as usual. At the end of a compaction, when an unreadable path is a
  file the runtime holds, the whole re-read is dropped, the same as a failed
  re-read (held content and reason stay). An unreadable path that the runtime
  does not hold does not block the re-read. The next start or compaction reads
  the file again. Known limit: a file that is unreadable at the runtime start
  is not held, so a full block that a later compaction places before the
  summary does not have it until a read succeeds.
- **Baseline from history.** Each `context_prefix` record stores, in runtime
  metadata that never reaches the provider, the files it announced:
  `{ path, type, hash }` for each file (`hash` = sha256 of the trimmed body),
  plus `removed` paths and a `reason` for a delta. The announced state is the
  last full record (no `reason`) with every later delta applied in order:
  `files` replace entries with the same path, `removed` deletes them. A legacy
  record without this metadata is a full record; its files come from its
  `Contents of <path> (<type>):` headings.
- **Every request.** Before each model request the runtime compares the
  announced state with the files it holds. The held files get their hash once,
  when the runtime builds them from a read (start, compaction, a config
  change); a request compares stored hashes and hashes nothing, except a legacy
  record without metadata, whose headings it splits and hashes. The comparison
  runs on every request although the held files change only at a read, because
  history changes between reads (rewind, compaction, a delta that was not
  saved) and the baseline is derived from history alone. No baseline: announce the full block
  (unchanged format). A file that is new or whose type or hash differs: append
  one delta. A baseline path that is no longer current: list it in `removed`.
  No difference: append nothing. A second cold resume with unchanged files
  therefore appends nothing.
- **Reason.** The delta reason is runtime state: `session_start` when the
  runtime starts, `compaction` from the moment a compaction commits its
  re-read. A compaction without a re-read (subagent, read failure) does not
  change it. A resume from the store (also when it reuses the same runtime)
  sets it back to `session_start`, because the files it compares were read at
  that resume. A rewind keeps it.
- **Compaction.** The leading announcements before the summary check the kept
  tail. For `context_prefix` the kept tail counts only when it holds a full
  record; a kept delta does not count. So the leading entry is the full block
  or nothing, never a delta:
  - kept tail holds a full record: nothing before the summary; a difference is
    appended as a delta (reason `compaction`) by the next request;
  - kept tail holds no full record and is not empty: the full block before the
    summary, built from the re-read content;
  - kept tail is empty: no leading announcements; the next request announces
    the full block.

  Known edge: when the kept tail holds only a delta, that delta comes after the
  leading full block, so the next request sees its older copy as the latest
  and appends one more delta for the same files.

- **Delta text.** Changed and new files share one sentence:
  `Instruction files were re-read <reason>; these differ from their earlier copies — each replaces its earlier copy, and the instructions preamble above still applies:`
  followed by a blank line and the same `Contents of <path> (<type>):` blocks
  as the full announcement. Each removed path adds a paragraph
  `Instructions no longer present: <path>`. When only files were removed, the
  first paragraph is `Instruction files were re-read <reason>.`. Paragraphs are
  joined by a blank line. `<reason>` is `when this session started`
  (`session_start`) or `after the conversation was compacted` (`compaction`).
- **Memory index.** `MEMORY.md` is one file of the same announcement (type
  `user's auto-memory, persists across conversations`). Read-file state records
  the content the runtime read (at start, and again after compaction once the
  compacted read state is installed), which is the latest content the model
  was told. A Write to `MEMORY.md` is checked against that content.

A delta keeps the `context_prefix` source, so it stays on the user side under
MCS like the full block. An older CLI that still updates restored
`context_prefix` entries in place would turn a delta into a second full copy;
the model then sees the instructions twice, but the session still works.
Dates always use the runtime clock, including the
first announcement after compact; the session-start context snapshot date is
not reused. Subagent runtimes inherit the parent clock.

The `OS Version` bullet is `<process.platform> <os.release()> <os.arch()>` (for
example `darwin 24.3.0 arm64`), and `Shell` is the selected shell's display
name or the `SHELL` executable name.

New dynamic entries are saved as hidden runtime reminders, the same record the
ToolSearch announcement and the compaction attachments use: a model-only
synthetic user message with semantics `agent_runtime` / `system_reminder`
(hidden from the App transcript, visible to the provider, never a turn trigger)
and the type in `runtimeMessage.source`. The record has no top-level `source`:
the App checks that field against a closed list, so a new value would make older
versions reject the whole session. Persistence must
succeed before an entry is committed to in-memory history. Resume restores the
source and raw content; compact restates its own set (see
[Rewind / Compact](../rewind-compact.md)) and rewind derives re-announcement from
remaining history. A legacy session with no dynamic announcements gets its
missing sources on the next model request. Historical text is not rewritten when
the model or date changes.

A hidden reminder is model context, not a conversation message. It is a user
record with `semantics.kind = "system_reminder"` and `uiVisibility = "hidden"`:
the records above, the interrupt marker, and hidden synthetic announcements such
as the agent listing. A model-only input that starts its own turn (for example a
goal continuation) is not a hidden reminder. Code that looks for conversation
messages skips hidden reminders: the assistant-anchored rewind walks back past
them to the turn's user input; the resume / rewind `turnNumber` count leaves them
out; writing one does not move the conversation pointer, so the compaction
coverage boundary (`lastSummarizedMessageId` / `tail_start_id`) and the timeline
anchors are the same live and after resume; the fork model-selection fallback
skips them. One predicate (`isHiddenReminderMessage` in
`runtime/helpers/conversation.ts`) decides this. Memory Extraction uses the same
predicate but counts the interrupt marker.

Source metadata never reaches the provider. Initial prefix rebuilding updates system messages only and
does not remove or duplicate historical dynamic announcements. A legacy session
whose prefix still holds an unmarked instruction reminder treats that reminder
as prefix, so the next request announces `context_prefix` once.

Custom system prompts omit the default system body and Git content. The custom
text is sent as given after the block's leading `\n`, without trimming.
Environment and model announcements are still sent. Their instruction context and
separate date remain available.
Main and ordinary subagents share one environment/model section assembler.
Subagents keep their dedicated agent prompt and Notes in the initial system;
environment and model use the same dynamic sources, history, deduplication,
resume/compact and MCS projection as Main.
The child receives the context source port for environment reads; instruction
injection still uses only the explicitly selected parent instruction snapshot.
At spawn, a parent environment announcement for the same cwd supplies the
current facts; it takes precedence over the session-start environment snapshot.
The child keeps its own accepted announcement history after creation.
The child task is the child's prompt for projection: announcements precede it
and the user text right before it ends with a newline, as in Main.
No Main Git session context, Desktop guidance or Project Memory is added to
the child. Date and Skills keep their existing shared formatters and runtime
collectors. Workflow actors keep using the main dynamic collection.

## Preserved policies and coverage

Skill paths, aliases, description truncation and total metadata budget are
unchanged; only the carriers of the listing and the instruction files moved
from the context prefix to the dynamic announcements. Memory index cleaning
and the 200-line/25,000-character limits are unchanged. Truncation notices now
name the omitted line range and preview its first line; a cut within the first
line reports the retained character count instead. Explore's listing uses an
em dash in its existing lean description. Ancestor instruction accumulation,
nested-directory instruction discovery, and notices for externally changed read
files remain separate future features.

Tests cover initial placement and order with and without MCS, the newline
before a real user input, MCS downgrade, consecutive
requests, executing model changes, date rollover, cross-day compact, resume,
Skill listing restated by compaction, updated in place after a history load
(removed for an empty catalog) and not repeated for an unchanged catalog, `context_prefix` kept byte-stable after a history load with an appended delta for a changed, new or removed instruction file or Memory index (none for unchanged files, none again on a second cold resume, legacy records without metadata), the compaction re-read (delta with a kept baseline, full block without one, Memory read state after compaction), read errors (an unreadable instruction file or Memory index not announced as removed on resume; a compaction re-read dropped when a held file is unreadable and adopted when the unreadable file is not held; adapter: an unreadable file reported as a read failure, a missing one as nothing, no fallback to a parent file when the check fails), Git reuse by history, Git read after a non-repository start or a non-repository compaction, one file system check per non-repository directory (including a non-repository prefetch), a repository with a hung or missing git still detected, parallel snapshot commands, prefetch only for a new session, custom/subagent
boundaries, and truncation at both limits. Prompt changes do not alter App input
or tool execution UI.
