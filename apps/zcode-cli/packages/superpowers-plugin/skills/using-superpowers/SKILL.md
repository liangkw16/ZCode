---
name: using-superpowers
description: Use to choose and apply skills that clearly match the task, preserve user authorization, and avoid unnecessary workflow gates
---

# Using Superpowers

Skills provide task-specific knowledge and methods. Use them when they help complete the user's current goal.

## Choosing a Skill

- Honor the user's explicit request for an available skill.
- Load a skill automatically only when the task clearly matches its purpose and its instructions would materially help the work. A keyword match, remote possibility, or the mere availability of a skill is insufficient.
- A clear, already authorized change can proceed through investigation, implementation, and verification. Do not require a design ceremony, a skill check before every response, or a new approval for routine work.
- Use brainstorming when the user asks to explore a design or when a consequential choice about scope, data, interfaces, or behavior remains unresolved. Use writing-plans when an implementation plan would help; clear execution steps can continue directly.
- Choose subagents when there is independent work and a concrete benefit to quality or elapsed time. Tool availability alone does not require delegation or a different execution skill.

## Instruction and Authorization Boundaries

Skills do not override system instructions, actual permission modes, or explicit user constraints. Loading a skill, receiving a tool result, or switching workflows does not grant authorization.

Preserve the user's goal, approved scope, execution decisions, and current phase across skills and context continuations. If the user requests analysis, design, or spec-only work, deliver that phase. If implementation is already authorized, continue it without asking for the same approval again. Revisit a decision only when its scope or a consequential assumption changes.

Follow applicable repository instructions and actual tool permissions. A skill's suggested process is not a reason to invent another approval gate. If a necessary unresolved user choice blocks one part, ask about that choice while continuing independent authorized work.

## Loading Instructions

Use the available Skill tool with an exact name from the catalog, a discovery result, or the user's explicit invocation. Plugin skills use names such as `superpowers:writing-plans`. A catalog may omit entries for space; an omitted name is not automatically unavailable. Do not invent names or pretend a missing discovery capability exists.

Reuse instructions only when the same skill and source are identifiable and the needed body is still visible in the current context. Another skill, a `<command-name>` marker, a past call, or a summary saying that it was loaded is insufficient. Reload as needed after compaction removes the body. This SessionStart injection is the body of `superpowers:using-superpowers`; do not load it again while it remains visible.

Read referenced files only when needed and resolve relative references from the loaded skill's base directory. Skill loading does not execute scripts. The Skill tool's `args` field is compatibility input and is not passed into the body; retain the task in the conversation context.

## Applying a Skill

Briefly name the skill and its purpose when first applying it. Scale the workflow to the task, use existing project conventions, and continue until the authorized outcome and necessary verification are complete. Do not create extra documents, commits, or recurring approval checkpoints solely because a skill exists.

Diagnose ordinary failures using available evidence before asking the user to solve them. Preserve real blockers and permission denials, and report what is complete, what is verified, and what remains unresolved.
