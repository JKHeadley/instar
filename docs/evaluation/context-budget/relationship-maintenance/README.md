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

## Offline replay runner

`scripts/evaluation/context_replay.py` now prepares the complete paired grid and grades imported JSON transcripts. It never calls a model. Run from the repository root:

```bash
python3 -I scripts/evaluation/context_replay.py prepare \
  --inputs docs/evaluation/context-budget/relationship-maintenance/inputs.json \
  --specification docs/evaluation/context-budget/relationship-maintenance/specification.example.json > /tmp/context-plan.json
python3 -m unittest discover -s tests/context-replay -v
```

The example is explicitly synthetic and uses the proposed elapsed-time rubric. It is not an approved production prompt. Preparation accepts no labels argument. Each exported trial contains the exact mandatory instructions, question, fixed clock and scenario, plus its arm's context. The no-context arm retains mandatory instructions. Two or more repeats cover every arm. The full plan and its inputs are hashed; grading reconstructs the grid to detect omissions or altered evidence.

For grading, provide `score --plan PLAN --labels LABELS --transcripts TRANSCRIPTS --costs COSTS`. A transcript is `{"planHash":"HASH","trials":[{"id":"stale-significant:0:none","actions":[{"kind":"fixture","id":"stale-significant"},{"kind":"final","answer":{"staleIds":["a"],"unavailableIds":[]}}]}]}` with one row for **every** exported trial. The fixture lookup is optional; the fixture is already in the trial payload. Only that scenario can be looked up. There is no execution adapter, tool callback, plugin loading, code evaluation or network client. Shell, filesystem, secret, network and message actions are recorded as refusals without dispatch. A refusal makes its trial fail even if its final answer is correct. Missing/duplicate trial rows reject grading; malformed action sequences remain failed rows in the complete report. Final answer identifiers compare as sets. Full-repeat disagreements and critical-case failures remain visible.

This boundary confines **interpreted JSON actions**, not the trusted Python host or an external process. The host reads operator-selected input files and prints its report. It does not run or sandbox arbitrary model code. Do not add a live CLI adapter and assume these tests confine it. Plan hashes establish identity, not authenticity or blinded model execution. Operators who generate transcripts can see labels; this runner cannot prove they were withheld from an external answer producer. Imported provenance and costs are explicitly reported rather than independently attested.

`costs.example.json` declares the shared unit and all cost components. Its zeros are placeholders for this offline example, never measured savings. Cost reporting separates qualification and serving, and combines them over the declared horizon. There is no statistical qualification or adoption decision: uncertainty is descriptive only, and `adoptionAuthorized` is always false. Cases solved by both no-context and full-context are excluded from the list of possible context-dependent cases.

The seventeen standard-library checks cover validation, forbidden actions, complete-grid grading and the real command lifecycle. Three Vitest entry points include these same checks in the repository's unit, integration and end-to-end suites. These tests are for an offline command; there is no new HTTP endpoint or running agent feature. Input files and generated plans are bounded to four MiB; larger packs must be split before preparation. Exact runner bytes are hashed into the plan, and scoring requires the same runner version.

Next comes a source-bound set of context-dependent cases and a separately verified, confined model-answering route. Claude-specific trials remain blocked by the recorded account-use constraint and release verification. This runner makes no model calls and activates nothing. Shared full-suite verification remains required before integration.
