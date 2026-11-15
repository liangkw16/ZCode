---
name: verification-before-completion
description: Use before claiming work complete to check that actual evidence matches the current version, environment, inputs, and acceptance criteria
---

# Verification Before Completion

Make completion claims only when observable evidence supports them. State what was verified, what was not, and what remains blocked or unknown.

## Evidence Must Match the Claim

Before claiming success:

1. Identify the acceptance criterion and the kind of evidence needed to establish it.
2. Check whether existing evidence covers the current code or artifact version, environment, inputs, execution stage, and acceptance type.
3. Reuse valid evidence. Run the missing or affected checks when relevant conditions changed, results are inconclusive, or the user requested another verification. Complete repository-required checks.
4. Read the result and exit status, investigate failures, and distinguish successful execution from successful acceptance.
5. Report the supported outcome and its limits. Never describe a skipped, failed, blocked, or unknown check as passing.

A new message, status question, skill transition, or compaction does not by itself invalidate evidence. Do not rerun a full suite merely to refresh the conversation. A relevant code change, environment change, changed input, or unmet acceptance criterion can invalidate prior results and requires the appropriate verification.

## Match Coverage and Acceptance Type

| Claim                   | Required evidence                                                          | Insufficient evidence                                        |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Targeted tests pass     | Actual results for the relevant tests and version                          | Confidence or an unrun command                               |
| All required tests pass | Results covering the required suite and current conditions                 | One targeted test extrapolated to the whole suite            |
| Build succeeds          | Successful build result for the relevant version and environment           | Lint passing                                                 |
| Bug fixed               | The original failure scenario or an appropriate regression no longer fails | Code changed or a process exited                             |
| UI behavior works       | The requested interaction and visible result were checked                  | API success does not prove UI success                        |
| Requirements met        | Each acceptance criterion has matching evidence                            | Todo items checked off or tests unrelated to the requirement |
| Delegated work complete | Inspectable artifacts and relevant validation evidence                     | A subagent's unsupported success report                      |

A partial check can establish a partial claim. Do not broaden it into a full-completion claim. If the user specified a verification method, another method does not automatically satisfy it; explain an actual limitation and preserve the remaining acceptance work.

## Recover and Finish

Diagnose ordinary failures before asking the user to resolve them. Use a representative case to confirm a costly verification path works before expanding coverage. A tool error or inconclusive result is not a passing check and should guide the next useful diagnostic action.

For delegated work, inspect the relevant changes and validation evidence. Repeat checks only when their conditions or coverage are insufficient, not solely because another agent ran them.

Once the requested acceptance criteria and required checks are supported, deliver the result. If necessary evidence cannot be obtained, report the exact completed scope, unresolved criterion, and blocker. Never invent a run, hide a failure, or present stale evidence as proof of the current state.
