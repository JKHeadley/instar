# 🧪 Relationship Maintenance Replay Preparation

This pack prepares a comparison for the scheduled job that identifies important contacts who have gone quiet. It contains sixteen invented development scenarios, proposed reference decisions, and the corrected trial protocol. It makes no claim about model quality, token savings, production correctness, or readiness for activation.

## What is ready

`inputs.json` contains the scenario evidence, fixed clock and simulated read failures. `labels.json` contains the proposed answers and safety expectations. A future runner must expose only inputs to the answering model and withhold labels until grading. File separation supports that boundary but does not enforce it. These are public development cases, never unseen qualification cases.

`label-check.json` records an independent arithmetic check of all sixteen labels using Python timezone-aware date parsing. Each stale-contact label uses strictly more than fourteen elapsed days and significance at least three. Missing, invalid or future dates and missing significance are marked unavailable. An unreadable store is distinguished from an empty readable one. This checks fixture consistency against the proposed rubric, not the running relationship manager.

`protocol.md` specifies no-context, reduced and full-context arms, full-context repeats, separate critical-case scoring, uncertainty, enforced read-only replay and completed-task costs. Padding can be an extra diagnostic; it cannot replace the no-context arm or repeats.

## Important limits discovered during preparation

At source commit `aa1f50b67876c8f66621c85df1bdbf145c0d66af`, `src/core/RelationshipManager.ts` uses local-calendar `setDate` arithmetic and string comparison in `getStaleRelationships()`. The job instructions say “over 2 weeks” without deciding between calendar days and elapsed time. Therefore these labels cannot silently become the product contract. Resolve daylight-saving and equivalent-offset handling before qualification. No production change is included here.

These scenarios mostly ask for decisions directly derivable from their records and the task question. If the no-context arm performs as well as full context, that demonstrates task competence but supplies no evidence that shorter startup preserves identity, standing decisions or open promises. Qualification needs genuinely context-dependent cases written from the original instructions before reduction, including later corrections, reporting restrictions and applicable obligations. Their expected behavior must come from an authoritative source rather than invented personal preferences.

The first live destination for reports is unspecified. Keep all replay reports captured locally; do not contact people or send messages. Neither a prompt saying “read only” nor an allowlist written in this document establishes confinement. The runner must actually deny shell, filesystem, secrets and network access and prove those denials before any trial.

## Provenance and next step

The sixteen cases were prepared in topic 141133 on 2026-11-23 and preserved from `.instar/state/context-budget-next/job-startup-qualification/relationship-replay-development.json`. They audit shipped instructions from PR 3634 source commit `3324d786205325dadc4eefcb231bceb0e8536500`. That audit found this job unrestricted and its report destination unspecified; this pack does not change either setting.

The protocol correction was recorded in the same topic after finding that the original proposed third arm used padding instead of no context. The governing eight-obligation article was approved by Justin in message 146917, with the scope addition delegated in message 146931; its implementation remains separately frozen for shared verification. This pack neither edits that candidate nor treats its pending verification as complete.

The next implementation is an isolated fixture runner with enforced tool denial and a source-bound set of context-dependent cases. It requires its own review and applicable tests. Claude-specific trials remain blocked by the recorded account-use constraint and release verification; this pack makes no model calls and activates nothing.
