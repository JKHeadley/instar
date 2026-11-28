---
title: "Correction class review writes graded evidence"
slug: "correction-class-review-graded-evidence"
author: "echo"
parent-principle: "Verify the State, Not Its Symbol"
eli16-overview: "correction-class-review-graded-evidence.eli16.md"
approved: true
approved-by: "echo (agent self-approval under Approval Only Where Required: touches neither docs/STANDARDS-REGISTRY.md nor .github/CODEOWNERS; converged at the Tier 1 cap 2026-11-27, report docs/specs/reports/correction-class-review-graded-evidence-convergence.md; CMT-2086 from the 2026-11-20 feature review)"
review-convergence: "2026-11-28T01:12:08.938Z"
review-iterations: 3
review-completed-at: "2026-11-28T01:12:08.938Z"
review-report: "docs/specs/reports/correction-class-review-graded-evidence-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
---

# Correction class review writes graded evidence

## Problem statement

The correction class review (`monitoring.correctionClassReview`, `src/monitoring/CorrectionClassReview.ts`) reads each correction an operator makes, decides whether a standard already covers it, needs an upgrade or needs a new one, and whether a process gap exists, and files work for the gaps. Its maturation ladder (`src/data/feature-ladders.json`) can only advance on evidence. Two of its four bars read its own log (reviews filled, filled share) and one reads the model error rate. The fourth, its only quality bar, counts graded outcome rows for the feature in `logs/feature-evidence.jsonl` (`kind: outcome`, `outcome: wrong` over all outcomes). **Nothing writes those rows**, so the review's correctness is unmeasured. Fill rate (79% today) says the review ran, not that it was right.

The feature review of 2026-11-20 (CMT-2086) chose "improve": both reviewers asked for the filled rows and the error rate to reach the evidence log, and for correctness to be graded separately from fill rate.

## Proposed design

1. **A filled review is recorded as fired evidence.** As soon as `fill()` has stored a judgment (before any work item is filed, so a later bookkeeping failure cannot drop it), it records one `fired` row for `monitoring.correctionClassReview` with the verdicts (standard verdict, process verdict, confidence) and the correction's key in `context`, and `subject` set to the semantic class. No correction text is recorded: the summary stays in the class-review store, as today.
2. **A failed attempt is recorded as error evidence.** `failAttempt()` records one `error` row with a fixed reason code (`invalid-structured-output`, `provider-unavailable`, `provider-error`, or `post-fill-error`; never the raw message, which after a fill can echo text built from the correction and stays in the review's own audit), whether it dead-lettered, and its `stage`: `review` when the judgment never landed, `after-fill` when the judgment was stored and a later step (an audit callback, filing work) failed, so a bookkeeping failure is not counted as a model failure.
3. **An operator decision on a proposal grades the review.** The review proposes work on an arm when its fill-time verdict is a proposal (`needs-upgrade` or `new-standard-needed` on the standard arm, `process-gap` on the process arm), which sets that arm's outcome to `proposed`. Only such an arm is ever graded (`armWasProposed`). When the operator decides it through the PIN-gated outcome route, `ClassReviewStore.transitionOutcome()` records one `outcome` row grading that arm's proposal:
   - `ratified` or `shipped`: `right` (the operator took the proposal).
   - `rejected`: `wrong` (the operator decided it was not needed).
   - `deferred` (or `expired-unreviewed`, set by a timer): no grade; nothing was decided.

   The decision grades **whatever the arm's prior outcome was**: proposed, put off, or already `shipped` because the agent completed its own action on the unpinned route. So the agent shipping first cannot keep the operator's rejection out of the count, and an operator confirming `shipped` after the agent set it is graded too. A repeated decision writes the same grade again under the same id, which the ladder counts once. When the operator decides the same proposal again (after a deferral, a reopen on recurrence, or a change of mind), another row is written under the same id, and the ladder keeps the latest row per id: **the latest decision stands**.

   `gradesEventId` is `class-review:` plus the first 40 hex characters of a SHA-256 of the review's key and the arm: a fixed-length digest of the whole identity, so the log's 64-character field never cuts it and two proposals never share an id. The ladder's `dedupe: "gradesEventId"` counts one grade per proposal (its latest row). `gradedBy` is `operator-outcome`: **only the operator's PIN-gated outcome route grades.** An action completed on the unpinned actions route still marks the process arm `shipped`, but writes no grade (`gradedBy: null`), because the agent's own session usually completes its actions there, and a grade it could write would be the review certifying its own work. The grade is written after the store update succeeds, never before.
4. **Arms closed as `no-action` at fill time are not graded here.** A `covered` or `not-applicable` verdict files nothing, so no person accepts or rejects it. One later signal does exist: the correction class recurring under the same key suggests the "no gap" call was wrong. Grading that (as a separate `gradedBy: recurrence`) is a follow-up, CMT-066, due 2026-12-11. <!-- tracked: CMT-066 -->

   > **CMT-066** — "Design and propose grading a recurrence after a no-action call (gradedBy recurrence, kept separate from operator grades), or record why not, by 2026-12-11."

Fill rate stays where it is (the review's own log); quality is now its own measure, from decisions the review does not make.

**What the grade is, stated plainly.** It is *acceptance*: whether the operator took the review's proposal. That is a proxy for correctness, not correctness itself. A sound proposal can be rejected for cost or timing and counts as wrong; a weak one can be ratified and counts as right. It is the only independent decision the system records about a proposal today, which is why it is used, and the ladder's bar is read by the recurring feature review together with the reasons, never as a verdict alone. Coverage is visible beside it, counted per proposal: the unit is a `(review key, arm)` pair whose fill-time verdict was a proposal (the fired rows carry the key and the verdicts), and coverage is the share of those pairs fired in a period that have a grade (joined by `proposalGradeId(key, arm)`) by the reporting cutoff, each pair counted once however often it was redecided; grades with no matching fired row (for example reviews filled before this change) are reported separately. The ladder computes the wrong-rate only; the feature review computes coverage from these rows. Missing grades read as unknown, never as right. Process arms the agent shipped, and proposals left to expire, stay ungraded. Gaps the review missed (an arm closed as `covered` or `not-applicable` that was really a gap) never enter the count; that limit is named under Side effects.

## Decision points touched

| Decision point | Classification | Floor / justification |
|---|---|---|
| Outcome to grade mapping (ratified/shipped right, rejected wrong, others none) | invariant; basis: enumerable-domain; evidence: `OutcomeLifecycle` is a closed set of seven values and each maps to exactly one grade or none | A value outside the set is never graded. |
| Grade only an arm the review proposed, on each operator decision | invariant; basis: enumerable-domain; evidence: the fill-time verdict says exactly whether the arm was a proposal, and a decision is one of three closed outcomes (ratified, shipped, rejected) | A `no-action` arm is never graded, even through deferral; a deferral or an expiry grades nothing; every operator decision grades, whatever the prior outcome (including one the agent set), and a repeat counts once because the ladder keeps one row per id. |
| Latest decision stands after a reopen | invariant; basis: external-constraint; evidence: the ladder's evidence reader keeps the last row per `gradesEventId` (`LadderEvidenceReader`), and a reopen means the class came back | The earlier row stays in the log as history. |
| Grade id as a digest of the whole key | invariant; basis: external-constraint; evidence: the evidence log keeps `gradesEventId` to 64 characters, and a cut key could merge two proposals | Fixed 40-hex digest of key and arm. |
| A lost grade after a crash | invariant; basis: irreversible-consequence; evidence: the outcome is written first and the grade after it, so a crash between them (two synchronous calls in one tick; only a process death between them) can lose a grade but never record one for an outcome that did not happen | A lost first grade reads as one fewer sample, the honest side (the log's own rule). A lost redecision is worse: the earlier grade stays the latest row, so a rejection later ratified would still read wrong. It happens when the evidence append fails after the outcome is stored, by a process death between the two synchronous calls or by the log's own write failing (it swallows errors by design, a full disk say). That failure mode is accepted and stated, not engineered around: a durable pending-grade queue in the outcome transaction would double the state for a rare stale grade, which the feature review can still see by comparing the class review record's current outcome with the latest grade. No repair sweep: the store keeps no record of which decisions were graded, so a sweep could not tell a lost grade from a decision made before this change. |
| Operator grader names are reserved on the open evidence route | invariant; basis: irreversible-consequence; evidence: the route is reachable with the agent's bearer token, the grade id is computable from the public review key, and a forged latest row would cancel the operator's rejection | `operator` and `operator-*` refused with 400; in-process writers that checked the operator keep using them. |
| The grader argument is required, with no default | invariant; basis: irreversible-consequence; evidence: a default grader would let any caller that says nothing mint operator grades | The PIN route passes `operator-outcome`; every other caller passes `null`. |
| Who grades | invariant; basis: irreversible-consequence; evidence: a grade the agent could write would certify its own work; the actions route has no PIN and the agent's session completes actions there | Only the operator's PIN-gated outcome route grades; the review writes fired and error rows only; an action completion grades nothing. |

## Frontloaded Decisions

- The grade is written in the store's `transitionOutcome`. Its `gradedBy` argument is required: the PIN-gated outcome route passes `operator-outcome` after its PIN check, and every other caller (the unpinned actions route, the store's own deferral) passes `null` and grades nothing. The ladder's graded-wrong bar also filters on `gradedBy: operator-outcome` in both its numerator and denominator. That filter holds only because no other writer can put that name on a row: the open evidence route (`POST /maturation/evidence`, reachable with the agent's own token) now refuses any `gradedBy` of `operator` or starting `operator-` (`isReservedGrader`), so a grade in the operator's name can only come from in-process code that checked the operator (this route's PIN, and the skill-learning confirm, which already writes `operator`). The open route still accepts other rows with any `gradesEventId`, so the ladder's evidence reader (`LadderEvidenceReader`) now lets only a row inside a metric's scope (matching its `where` or `of`) take an id's last-row slot: a row from another feature, kind or grader sharing the id can no longer overwrite, and so erase, an operator grade. This fixes the shared reader for every ladder metric that dedupes.
- `gradesEventId` is a digest of the proposal's identity (review key and arm), not the fired row's random id: the store would otherwise need a new column to carry the id from fill to outcome.
- No new config, flag, file or stored state: rows go to the existing shared evidence log through `featureEvidence.record`, which never throws.
- Who reads the new rows: the ladder's quality bar reads the outcome rows; the fired and error rows are read by the recurring feature review (coverage, verdict mix, error stages). The ladder entry's tracking note says so.

## Multi-machine posture

No new state surface: the rows go to the existing feature evidence log, whose posture is already declared machine-local in `src/data/state-coherence-registry.json` (`feature-evidence-log`, transport none), and the ladder reads each machine's own log. A review's outcome is single-writer state on the machine that holds the review (`local-authoritative`), so its grade is written once, there. Consequence, stated: on an agent with several machines, each machine's ladder sees only the grades of reviews it holds, so the 5-grade bar may take longer to reach on any one machine; the recurring feature review reads every machine's ladder. Pooling the evidence read is the log's own question, not this change's. The log exists only where the maturation ladder runs (`maturation.ladder.enabled`, on by default for development agents only); elsewhere `featureEvidence.record` does nothing, as for every feature. So after any fleet move, fleet machines record no grades unless their ladder is on: graduation evidence comes from the development agents, which is where the ladder is read.

## Maturation plan

- **test-agent-live:** on a throwaway agent with the review on and `maturation.ladder.enabled: true` (the evidence log is wired only where the ladder runs; a throwaway is not a development agent by default), record a correction, let it fill, set one arm ratified and another rejected through the outcome route; confirm one fired row, two outcome rows (right, wrong) with the expected `gradesEventId`, that a deferral writes none, and that completing the filed action writes none.
- **dev-agent-live:** ships with the review, which already runs on development agents; the next two weeks of operator dispositions supply the graded rows the ladder's quality bar reads. If no dispositions come in, the bar stays unmeasured (not passed), and the feature review says so.
- **graduation criterion:** the ladder's existing bars, unchanged here (at least 5 graded outcomes in 30 days with no more than 10% wrong, beside the fill and error bars). Meeting them triggers the recurring feature review, which reads the grades with their reasons; a move to fleet default needs that review's two independent readings, as for every feature.
- **fleet:** decided by the recurring feature review on the ladder's evidence, as above; this change adds no flag.
- **dark-window:** none; this adds evidence rows to a feature that already ships behind its own flag.
- **ladder:** monitoring.correctionClassReview

## Side effects and rollback

- One more short row per filled review, per failed model call and per graded outcome in the shared evidence log, which already rotates its segments.
- The grade is acceptance, not correctness (see the design): read with its reasons, never alone.
- Not covered, named: whether a `covered` or `not-applicable` call was right. Nothing later decides that, so it stays ungraded; a sampled audit of those calls would be its own change.
- Rollback: revert stops new rows. Rows already written stay in the log and the unchanged ladder keeps reading them for the rest of their 30-day window; if grades written by this change must be excluded, they are identifiable by `featureId` and their `gradesEventId` prefix `class-review:`.
- The evidence row records only the disposition (`reason` names the arm and outcome). The outcome route takes no reason, so the operator's own reasoning exists only where they wrote it down elsewhere; the class review record holds the model's fill-time rationale, which does not explain a later operator decision.

## Tests

- **Unit, review:** a fill records one fired row with the verdicts and no correction text; a failed attempt records one error row; a dry run records nothing; with an audit sink that throws on every event, the fired row and the error row (labelled `after-fill`) are both still written.
- **Unit, store:** `proposed` to `ratified` and `rejected` each write one outcome row with the right grade, `gradesEventId` and `gradedBy`; a deferred or expired proposal later decided is graded; an arm the agent shipped first is graded right when the operator confirms it and wrong when the operator rejects it; a repeated decision writes the same grade again under one id; a move to expiry, a missing record, a transition with no grader (`null`) and an arm that was never a proposal (even through deferral) write none; rejected, then deferred, then ratified writes two rows under one id, the latest right; the grade id is a fixed-length digest that differs per arm and per key; the grade is written before the record's change event, so a failing listener cannot drop it.
- **Unit, ladder:** the shipped `graded-wrong` metric, read through the real `LadderEvidenceReader`: five proposals with one changed from rejected to ratified give five samples and none wrong; reversing it gives one in five wrong, over the bar; an ungraded transition and a row with another `gradedBy` never reach the bar.
- **Unit, reader:** a later row under the same grade id from another feature, kind and grader leaves the bar unchanged (five samples, one wrong).
- **Integration, actions route:** completing an action tagged with a class-review key through `PATCH /evolution/actions/:id` marks the process arm shipped and writes no grade.
- **Integration, evidence route:** a POST with `gradedBy` `operator-outcome`, `operator` or any `operator-` name is refused and writes no row.
- **Integration, route:** through the real PIN-gated outcome route, a refused PIN writes no grade, and ratified and rejected write right and wrong. The unpinned actions route is held to no grade by the required `gradedBy` argument (it passes `null`; omitting it fails the type check) and by the unit tests of `null` transitions.

## Open questions

*(none)*
