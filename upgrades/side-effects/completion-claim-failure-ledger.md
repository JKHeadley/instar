# Side-Effects Review — Completion-claim failure ledger and shared-cap repair

**Version / slug:** `completion-claim-failure-ledger`
**Date:** `2026-10-30`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see end)`

## Summary

Tier 1, about 9 source files plus tests. Moves the verifier off the shared LLM queue, records every failed turn without content, and holds observe-only behind a 7-day failure gate. Spec review: one round (second-pass subagent).

## Decision points

The change adds one: `isObserveOnly()`. It can only hold the existing behavior (Action-Claim stays in charge). It cannot block, rewrite or delay a message.

## 1. Over-block

The hold could keep the verifier observe-only for an install that set `dryRun: false`, including during the first 7 days after this ships. Intended: that install then runs the same path as dry-run, which is the shipped default. Quiet installs under 20 turns a day never pass; also intended, since such days prove nothing. Privacy-boundary skips count as successes in the rollup: they are a coverage decision, not a failure, and they are counted in `coverageIncompleteTurns`.

## 2. Under-block

Parse-level failures may remain and may exceed 5%. The ledger now names them; this change does not claim they are gone. The rate-limit refusal in the admission queue (`rate-limit-exhausted`, 30 a topic an hour) and `queue-full` happen before the turn counts as a candidate and are still outside the ledger; they were outside the 41% too.

## 3. Level-of-abstraction fit

Budget separation belongs at construction, matching `correctionLlmQueue`. Attribution belongs at the arbiter, the one place that sees both the error and the parse. The ledger is a separate small class so the verifier does not grow more file handling.

## 4. Signal vs authority compliance

Compliant. The ledger is a signal. The gate has no blocking authority over any message; it only withholds a promotion to more authority. The 5% threshold is a brittle number, but it is applied to the feature's own eligibility and fails toward the existing path.

## 5. Interactions

PromiseBeacon and the other shared-queue callers regain the share the verifier used; this is a behavior improvement for them, and any of them that had been silently refused will now run more. The verifier's calls no longer pass through shared-queue pacing or interactive preemption. The host-wide spawn cap still bounds concurrent provider processes. The `general` envelope logic is unchanged. Parse accept and reject outcomes are unchanged; tests name every reachable branch (`general-envelope` in the verifier test, `parser-exception` is a defensive catch with no known input). Claim calls can now run alongside the shared queue, so peak concurrent LLM calls rises additively by up to 4 (`maxConcurrent`); the host-wide spawn cap still bounds processes.

## 6. External surfaces

More model calls: up to all candidate turns (about 550 a day here, versus about 340 now), still under the component budget. At about 14k input tokens a call, 550 calls is 7.7M of the 10M daily input budget, so a busy day can reach `component-budget`. That is the correct bound, and the ledger names it when it happens. One new authenticated read route. No user-visible messages.

## 7. Multi-machine posture

Machine-local by design, like the stats and audit files beside it: each machine runs its own verifier, spends its own budget and evaluates its own gate. The route reports `scope: local`. No replication and no notices.

## 8. Rollback cost

A revert. No migration is needed for state; the two new log files are inert. CLAUDE.md gains one awareness bullet via an idempotent migration, which is harmless if left behind.

## Found problems (triage)

- `extractionGapSignals` reports `invalid-envelope` on every turn on non-Claude installs, because the general envelope is deliberately not requested. Queued to feedback: inflates `protectedCueGaps` and `coverageIncompleteTurns` but not the failure rate.
- Spend caps charge an estimate even for subscription calls, which cost no real money. Queued to feedback.

## Second-pass review

Independent reviewer found parse behavior unchanged, no content path into the logs, every route site holding toward Action-Claim, and no bound lost. It raised one concern: this artifact overstated branch coverage. Resolved by adding tests for the missing parse codes and correcting section 5, and by disclosing the privacy-boundary counting and additive concurrency it also noted.

Concur with the review, after the coverage correction above.
