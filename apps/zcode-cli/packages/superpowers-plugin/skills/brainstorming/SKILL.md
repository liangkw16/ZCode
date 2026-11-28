---
name: brainstorming
description: Use when the user requests design exploration or a consequential unresolved choice needs clarification before implementation
---

# Brainstorming Ideas Into Designs

Turn an uncertain idea into a concrete, reviewable design. Start from the user's current goal, existing decisions, and project context.

## When This Process Helps

Use this process for a requested design discussion or a consequential unresolved choice about scope, data, interfaces, or behavior. A clear, already authorized local change can proceed directly through investigation, implementation, and verification without another design approval.

A user request for analysis, design, or spec-only work defines the current deliverable. Writing a spec authorizes documentation work, not product implementation, and does not itself require entering a mode that forbids all file writes. Follow the actual permission mode.

Skills do not override system instructions, tool permissions, or explicit user constraints. A previously approved design remains valid: recording it, switching skills, or continuing after compaction does not require another approval. Revisit only a materially changed scope or consequential choice.

## Ground the Design

1. Read the relevant implementation, repository instructions, and existing specs. Resolve discoverable facts before asking questions.
2. Identify the intended outcome, constraints, and observable acceptance criteria. Distinguish confirmed facts from assumptions.
3. Ask only about decisions that cannot be resolved from the environment or reasonably chosen within existing authorization. Keep each question focused and offer a recommendation where helpful. Continue independent work while a necessary answer is pending.
4. Compare alternatives when a real tradeoff exists. Describe the recommended approach and its consequences; do not manufacture several options for an already settled choice.
5. Present one coherent design at the detail needed for review. Request a decision only for a real unresolved choice or a review stage the user requested.

For a large request, identify independently deliverable parts and their relationships. Organize the work into manageable stages without discarding the overall goal or adding approvals for every small section.

## Design for Clear Boundaries

- Give each unit a clear responsibility and explicit interface. Identify owners of state, dependency directions, and observable results.
- Explain data flow, error handling, relevant platform constraints, and how acceptance will be checked.
- Follow existing patterns. Include only targeted structural changes needed by the task; avoid unrelated refactoring.
- For asynchronous or remote state, describe event order, identity, cancellation, and recovery boundaries using the repository's existing mechanisms.

## Documentation and Review

Maintain the existing spec or design document required by the repository or user. Do not create a separate design document for every small change. If a new document is useful and no location is prescribed, use `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.

Check the document for contradictions, placeholders, unclear ownership, scope drift, and missing acceptance criteria. Fix issues directly. Documentation does not itself authorize a Git commit; commit only within the user's authorization.

If the user asked to review the design first, deliver the concrete design and wait for that decision. If the design and implementation are already authorized, continue the work without a duplicate review gate. Use writing-plans when additional planning would help; otherwise continue the established execution workflow. If the user requested only the design or spec, that phase is the completion boundary.

## Visual Explanations

Use an available visual capability when a diagram, mockup, or comparison would make a real decision easier to understand. Do not require a separate visual-companion offer before ordinary work. Opening a service or using a tool still follows its actual capability and authorization requirements.

If the user chooses the packaged visual companion, read `visual-companion.md` relative to this skill before using it. For conceptual choices or short explanations, text is sufficient.
