# Side-Effects Review — one imperfect readiness answer never voids the operator's approval

**Version / slug:** `feedback-readiness-violation-brake`
**Date:** `2026-10-02`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Live on 2026-10-02 at 02:30:22 PDT (Mac Studio, v1.3.1315, authority generation 4), drain run
`run:2e06aa3b` made one readiness call. It was 10 due candidates; one title tripped the
injection pre-filter, so 9 went to the model. The call was gpt-6-astra via codex-cli, 15,956
tokens in and 785 out, 37.7 s, and the LLM call itself completed normally. Then
`drain_audit` seq 123 demoted generation 4 to `proposal-only` with
`readiness-schema-provenance-or-routing-failure`. Every later tick returned 403 until a PIN
re-approval. Nothing recorded which check failed. The judgment-provenance log kept only a
masked head of the reply.

**Root cause, reproduced.** Real gpt-6-astra calls were run through the real
`FeedbackReadinessArbiter` and `CodexCliIntelligenceProvider`, with the same prompt, on the
same 10 candidates, rebuilt from a read-only copy of `clusters.jsonl`. 2 of 3 calls failed
with `ReadinessContractViolation: readiness authority cited evidence outside the candidate
packet`. Two near-duplicate clusters (`…reflection-trigger-job-activity-log-jq-does-not-com`
and `…reflection-trigger-job-feeds-itself-zero-activity-j`) each cited the other's evidence
id `cluster:<sibling>`. Everything else in the reply was valid. It was the model's output,
not a refused promotion (`DrainConflictError`): none of the 10 rows was approved, and all
were stamped `readiness-authority-failed`. Two more real calls on the fixed code came back
clean.

### The redesigned brake

Each failure class, and what it does now:

- **Canary drift** (prompt, schema or decision-point id differs from the approved record).
  - Demotes at once (unchanged). The deployed decider is not the one approved.
- **Resolved model or framework differs from the approved record.**
  - Demotes at once (unchanged). The approved decider is not the one answering.
- **Batch over the approved `maxBatch`, or candidate input below its floor.**
  - Demotes at once (unchanged). The call left the approved envelope.
- **Daily spend cap.**
  - Demotes at once (unchanged). The envelope was exceeded.
- **Output shape: invalid JSON, a decision count different from the candidate count, changed
  or duplicated ids, a forbidden outcome (`held`), confidence outside 0-1, or invalid reason
  codes.** All are new `ReadinessOutputRejected` cases.
  - Before: demoted at once.
  - Now: nothing from the call is applied. Its rows are set to `readiness-output-rejected`
    and come due again in 15 min. The call counts as one transient failure.
  - The authority is demoted only after `READINESS_TRANSIENT_FAILURE_LIMIT` (3) ticks in a
    row with no usable answer, with the reason `readiness-authority-repeated-invocation-failure`.
- **A row cites no evidence, or evidence that is not its own.**
  - Before: the whole answer was a contract violation and demoted at once.
  - Now: that row alone can never be `ready`. A `ready` or `collecting` row becomes
    `collecting`, and a request for a human (`escalate-human`) stays one. Its first reason
    code is `evidence-not-own`, and it keeps only its own cited ids.
  - The rest of the answer stands.
- **`DrainConflictError` while applying decisions (a refused store write).**
  - Before: demoted at once.
  - Now: a failed call that counts as a transient. The model controls none of its causes (a
    state race, an authority rotated mid-tick, an invalid nonce). On an authority rotated
    mid-tick, the old code's `demoteAuthority` itself threw.
- **Timeout or provider error.**
  - Transient (unchanged).

**Why the per-row evidence floor rather than salvaging all partial answers.** The live failure
was a per-row evidence fault inside an answer that was otherwise valid. Evidence is the floor
for *approval*, and a row that fails it is simply not approved. That gives the same result a
per-row salvage would, but for one well-understood floor. For the other output faults (bad
JSON, a wrong id set, a forbidden outcome, a bad confidence or reason code), the answer's
structure or intent is suspect. Rejecting the whole chunk is simpler and keeps those
fail-closed. They are rare, and the transient counter covers them.

**Diagnosis.** Every failed call writes one `drain_audit` row: `kind='readiness-call'`,
`entity_id` = run id, `to_state` = `contract-violation` | `output-rejected` | `call-failed`,
and `reason` = JSON holding:
- `check`, the exact floor (for example `invalid-json` or `resolved-model-mismatch`);
- `message`;
- `callId`;
- `packetHash` (the first 16 hex characters of the provenance slice hash);
- `candidateIds` (up to 20, each at most 120 characters) and `candidateCount`;
- `resolvedModel` and `resolvedFramework`;
- `excerpt`: scrubbed with `scrubForStore` over a 3,000-character window, then cut to 600
  characters. For a per-row fault it is the offending row.

`FeedbackDrainStore.lastReadinessDiagnosis()` reads the newest such row, using the new index
`idx_drain_audit_kind(kind, sequence)`. `GET /feedback-factory/drain/status` exposes it as
`lastReadinessFailure`, plus `authority.pausedReason` and `authority.pausedBecause` (plain
words). The readiness-authority proposal gains `pausedBecause`, and the dashboard card shows
it.

**Operator-facing text.**
- `plainSummary` now adds: "An answer that fails the checks is set aside and retried; it
  pauses itself only at the daily cap, if a different model answers, or after three runs in
  a row with no usable answer."
- The summary is not a binding field, so changing it voids no approval.
- The brake wording in the CLAUDE.md template is updated, with a `migrateClaudeMd` rewrite
  from both earlier wordings.
- On a 403 the job body now names why the authority is paused.

## Decision-point inventory

- Readiness failure classification (`FeedbackDrainService.reviewReadinessInChunks` →
  `failed()`): modify. Only `ReadinessContractViolation` demotes at once.
- Readiness output floors (`FeedbackReadinessArbiter.parse`): modify. Output faults are
  re-typed and carry a check code. The evidence floor applies per row.
- Job tier-1 supervision (`feedback-factory-process` script): its message is enriched, but
  its outcome is unchanged (a 403 is still one failed run, with no retry).

---

## 1. Over-block

- Rows whose answer was rejected wait 15 minutes, the same as a timeout.
- A cross-citing row waits 24 hours as `collecting`, just like a model "collecting" verdict.
  A near-duplicate pair that the model keeps cross-citing stays collecting. That is the right
  outcome for a pair the model calls related; merging is the clusterer's job.

## 2. Under-block

- The question is whether a model that keeps giving bad answers can keep the authority.
  - It cannot: three ticks in a row with no usable answer still demote.
  - Rejected rows retry at 15 minutes while healthy rows wait 24 hours, so a bad chunk moves
    to the front, fails the first call, and is counted.
  - Spend stays capped per call.
- Per-row evidence floor:
  - It can never approve a row the old code would have approved differently. A row that
    fails it is never `ready`.
  - Other rows still pass every per-row floor: id, outcome, confidence, reason codes, own
    evidence, and ready only at 0.8 or more.
  - The one widening: a valid row is no longer thrown away because a sibling row in the same
    answer erred. That is exactly what the operator approved, namely per-candidate decisions
    by this model within the envelope.

## 3. Level-of-abstraction fit

The classification lives where it did: the error types are in the arbiter, and the brake
policy is in the service. The diagnosis goes into the existing `drain_audit` table with a new
`kind`; there is no new table. The status route reads it through one store method.

## 4. Signal vs authority compliance

Nothing new gets authority. The diagnosis is a record only. The brake still decides from the
error class, and only PIN-gated routes register authorities.

## 4b. Judgment-point check (Judgment Within Floors standard)

There is no new heuristic. The per-row rule is a deterministic floor: approval requires own
evidence. The class split is decided by what the failure means (identity or envelope, versus
answer quality), not by a threshold.

## 5. Interactions

- `READINESS_TRANSIENT_FAILURE_LIMIT` now counts output rejections and refused store writes
  too. A tick with any successful call still clears the counter.
- Run reason: an output rejection sets `readiness-output-rejected`, and the job body reports
  it as `drain run degraded: readiness-output-rejected`. Other failures keep
  `readiness-authority-failed`.
- The judgment-provenance log is unchanged. The diagnosis's `packetHash` prefix matches its
  masked `sliceHash`.
- `drain_audit` pruning (existing, 400 days) covers the new rows. At most one row is written
  per tick, because a failure ends the readiness loop, and each is under 8 KB.

## 6. External surfaces

- `GET /feedback-factory/drain/status`: new fields `lastReadinessFailure`,
  `authority.pausedReason` and `authority.pausedBecause`. They are additive.
- `GET /feedback-factory/readiness-authorities/proposal`: new field `pausedBecause`; the
  `summary` text is longer.
- Dashboard Feedback Drain card: the paused line now names the reason.
- CLAUDE.md template and migration: brake wording.
- Job body: the 403 failure text.

## 6b. Operator-surface quality

The paused state is now explained in one plain sentence on the card, the status route and the
job failure. The old card text ("the model answer did not check out") described exactly the
case that no longer pauses, so it was replaced.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local, like the drain store. The diagnosis lives in the owner machine's store. A
proxied tick's outcome was already owner-side.

## 8. Rollback cost

Revert the commit. The new `drain_audit` rows and index are inert for older code. The
older code would again demote on output faults.

## Conclusion

The brake keeps its fail-closed guarantees for the things that mean "not the approved
decider" or "outside the envelope". It stops voiding the operator's approval over one
imperfect answer. Every failure is now named durably.

**Operator re-approval: not needed for this change.**
- The prompt id, schema id, prompt text, binding fields and envelope are unchanged, so the
  current generation-5 approval stays valid.
- Generation 4, demoted at 02:30, was already replaced by generation 5. The 05:00 run under
  generation 5 succeeded.
- Live risk until this lands: the cross-citing pair is due again. The live server still runs
  the old parser, and it reproduced the cross-citation 2 times in 3. Generation 5 can
  therefore be demoted again before this lands. If that happens, one more PIN re-approval is
  needed after the update, and none after that.

## Second-pass review (if required)

An independent reviewer subagent reviewed the diff read-only and concurred. Nothing was
blocking. Its five low findings, all applied:
1. Scrub before cutting the excerpt, so a secret straddling the cut is redacted whole. Test
   added.
2. Keep `escalate-human` on a row with foreign evidence. Test added.
3. Do not claim own evidence the model never cited.
4. Index `drain_audit(kind, sequence)` for the status read.
5. Say that `lastReadinessFailure` is historical. The CLAUDE.md wording now says "`at` says
   when; it stays after later calls succeed".

## Evidence pointers

- Live store (read-only `.backup` copies under `/tmp/fvb/`):
  - `drain_audit` seq 123;
  - `drain_runs` `run:2e06aa3b` (37 s, degraded);
  - 10 readiness rows stamped 02:30:59.865 with `readiness-authority-failed`.
- `state/judgment-provenance/2026-10-02.jsonl` line 698: FeedbackReadinessArbiter, 9
  candidates, gpt-6-astra, 15956 in / 785 out, 37755 ms.
- Recorded replies, plus the incident candidates:
  `tests/fixtures/feedback-readiness-cross-cite-shapes.json`.
- Tests:
  - Unit: `tests/unit/feedback-factory/readiness-arbiter.test.ts` and
    `tests/unit/feedback-factory/drain-readiness-brake.test.ts`.
  - Integration: `tests/integration/feedback-drain-readiness-brake.test.ts`.
  - E2E: `tests/e2e/feedback-drain-readiness-brake.test.ts` (shipped job script against the
    production AgentServer).
  - All new brake tests fail on the pre-fix source (unit 6/6, integration 3/3, e2e 2/2).

## Class-Closure Declaration (display-only mirror)

Defect class: a judgment-output floor was typed as an identity breach, so a quality fault
carried an identity-breach penalty. It is closed by typing every arbiter failure into exactly
one of three classes: identity/envelope, output, or invocation. Only the first demotes at
once. Each class has a test on both sides of the boundary.
