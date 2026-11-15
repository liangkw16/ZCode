---
name: executing-plans
description: Use to execute an authorized implementation plan, recover from ordinary failures, and verify the requested outcome
---

# Executing Plans

Load the plan, confirm the current scope and constraints, execute authorized tasks, and report the verified result.

**Announce at start:** "I'm using the executing-plans skill to implement this plan."

## Review the Existing Plan

Read the plan and relevant repository instructions. Preserve decisions and approvals already made, including the selected execution method and the user's requested phase. Skill transitions and context continuations do not require another approval.

Resolve discoverable gaps by inspecting the code and environment. Ask only when a consequential user choice remains necessary and cannot reasonably be resolved within the existing authorization. Continue independent work that does not depend on the answer. If the user asked to review the plan before implementation, honor that stage.

## Execute and Recover

For each task:

1. Identify the intended behavior and the evidence that will establish completion.
2. Follow the plan and repository rules, adapting routine implementation details when evidence warrants it.
3. Implement within the approved scope and perform the necessary checks.
4. Record completion only when the relevant result is established, preserving unresolved work.

A missing dependency, a failing test, or an unclear local step is a reason to diagnose the cause, not automatically to stop and ask for help. Read the error, check the environment and relevant code, and repair ordinary failures within scope. Change strategy when evidence disproves the current approach; do not repeat an ineffective action without a changed condition.

Pause dependent work when progress needs a necessary unresolved user decision, additional authority, or an external prerequisite you cannot establish. Explain the specific blocker and completed independent work. Respect actual permission denials, user cancellation, and phase boundaries; persistence does not override them.

## Choose an Execution Method

Keep an already selected method. Otherwise, use subagents when there is independent work and a concrete benefit to quality or elapsed time. If work is tightly coupled or delegation would add overhead, execute it directly. The availability of subagents does not require a skill switch or a question about execution style.

Use a worktree or a related skill when it helps preserve workspace changes and fits repository requirements. Do not introduce a fixed chain of required skills or another approval solely to change execution methods.

## Complete the Authorized Work

Use verification-before-completion when its guidance helps assess the evidence. Evidence must match the current version, environment, inputs, and acceptance criteria. Reuse still-valid results; rerun affected checks after relevant changes or when evidence is insufficient. Complete repository-required checks.

Report what changed, what was verified, and any remaining limitation or blocker. Branch finishing, commits, pull requests, and external changes remain subject to the user's scope and authorization; a completion skill does not authorize them. Do not stop at offering to continue work that is already authorized and necessary.
