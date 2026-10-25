# Side-Effects Review — readiness authority: retry transient failures, survive same-machine restarts, per-candidate injection escalation

**Version / slug:** `feedback-readiness-demotion`
**Date:** `2026-10-01`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Live incident on the Mac Studio (2026-09-30/10-01). The operator approved the feedback readiness authority (codex-cli / gpt-6-astra, 50 per batch, $5/day) at lease epoch 22677. Run 1 recorded 50 "decisions" but made none ready. Run 2 demoted the authority to proposal-only, and nothing has been evaluated since. The evidence is in the live store (`drain_runs`, `readiness.reason_code`, `authority_posture`) and in `state/judgment-provenance/2026-10-01.jsonl` (`errorClass: CodexExecJsonTimeoutError`, latency 23306 ms). Three fixes:

1. `FeedbackReadinessArbiter.ts`: the model budget goes from 20s to 60s (`FEEDBACK_READINESS_MODEL_TIMEOUT_MS`). Contract violations now throw `ReadinessContractViolation`: canary/envelope drift, a resolved model/framework mismatch, or output outside the schema. A suspected-injection candidate is escalated on its own, and the rest of the batch goes to the model. One surrounding markdown fence is accepted.
2. `FeedbackDrainService.ts`: only a `ReadinessContractViolation` demotes at once. Any other failure (timeout, provider/router error, stage budget) leaves rows collecting with a 15-minute review, as before. It increments a consecutive-failure counter that demotes at 3 (`readiness-authority-repeated-invocation-failure`). The counter clears on success. A cancellation thrown inside the readiness try block is re-thrown, no longer swallowed. The readiness stage gets its own budget (65s). The run wall-clock ceiling goes from 90s to 115s, under the 120s run lease.
3. `FeedbackDrainStore.ts`, `readinessAuthorityProposal.ts`, `routes.ts`: owner tenure (`drain_owner_continuity` in `drain_meta`) is recorded when a run starts and when an authority is approved. A finalized restore resets it. Stores written before this change derive it from run history. `authorityOwnerCurrent()` replaces the exact `authority.ownerEpoch === ownerEpoch` comparison in the tick and in `canAgentMutateReadiness`. The proposal card treats the owner epoch as matching while tenure holds.

Also: the agent-awareness wording in `templates.ts`, plus an idempotent `PostUpdateMigrator` rewrite of the old phrase.

## Decision-point inventory

- Readiness authority demotion (`FeedbackDrainService.runAccepted` catch) — modify — contract violation → demote now; transient → retry, demote at 3 consecutive.
- Readiness authority owner check (tick + `canAgentMutateReadiness`) — modify — exact epoch → same-machine unbroken tenure.
- Injection pre-filter (`FeedbackReadinessArbiter.decideBatch`) — modify — per-candidate instead of whole-batch.
- Proposal `matchesProposal` / `approveAction` — modify — no "replace" for a same-machine epoch advance.

---

## 1. Over-block

The old code over-blocked in all three places. One slow model answer switched the authority off for good. A restart would have made the approval look stale. One harmless title escalated 49 other reports. After this change: a model reply wrapped in a single code fence is accepted. A reply in any other non-JSON shape is still a contract violation and demotes. That is deliberate: the schema is the floor.

## 2. Under-block

- A model that times out on every call now burns up to three attempts before demotion: 3 × $0.01 estimated reserve, inside the $5/day cap. The spend brake still applies to each attempt.
- Tenure is recorded in the drain DB. If ownership moved to machine B on a separate DB, and A later resumed on its own stale local DB without a restore, A would not see B's runs. The spec forbids that path: failover requires a restore and `finalizeRestore`, which resets tenure, and an unclean failover goes through the split-brain recovery packet into the same finalize. Within the spec's failover paths, no gap was identified.
- On stores written before this change, tenure is derived from run history: only this host's runs after the latest foreign run AND after the latest `restore` audit row count. The first run then persists it as the marker. Run history is pruned after 30 days, so a foreign tenure older than that is invisible to the derivation. That is acceptable, because a planned or unclean failover always goes through `finalizeRestore`, and its `restore` audit row is kept for 400 days.

## 3. Level-of-abstraction fit

Each change sits where the decision is made. The arbiter, which owns the contract, classifies its own failures. The drain service, which owns the authority lifecycle, decides demotion. The store, which owns durable owner and epoch state, answers "is this authority's owner binding current". The proposal module only consumes that answer.

## 4. Signal vs authority compliance

The demotion brake is deterministic floor logic over typed failure classes. It is not a judgment over content. The model remains the authority for readiness. The change narrows when a brittle signal (any throw) can remove that authority, and leaves contract breaks as hard floors.

## 4b. Judgment-point check

No new static heuristic at a competing-signals point. The injection regex is unchanged. Its blast radius is reduced from the whole batch to one candidate.

## 5. Interactions

- The spend brake (`reserveAuthoritySpend`) still runs before every attempt, so retries are capped by the daily envelope.
- Cancellation: before, a `FeedbackDrainCancellation` thrown by `stopIfCancelled()` inside the readiness try block was swallowed and demoted the authority. It is now re-thrown to the run's existing cancellation handling.
- A `DrainConflictError` raised while applying decisions (for example `approveReady` refusing an unauthorized promotion) demotes at once, as before. It is grouped with contract violations.
- Ownership-change errors from `assertOwner()` inside the block count as transient. The next `stopIfCancelled()` outside the block throws as before.
- An existing integration test (`feedback-drain-proxy-split-brain`) asserted that a same-owner epoch advance is refused. It now asserts the opposite, which is the intended behaviour change. A foreign-owner run is still refused (403).

## 6. External surfaces

- The dashboard readiness card: after a same-machine restart it no longer offers "replace" for an active authority.
- The `/feedback-factory/drain/status` reason strings are unchanged (`readiness-authority-failed`). One new demotion reason: `readiness-authority-repeated-invocation-failure`.
- Agent CLAUDE.md wording, via template and migration.

## 6b. Operator-surface quality

No dashboard renderer or markup file changed. The card's data now says "nothing to approve" after a restart, where it used to ask for a needless PIN approval.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. The drain DB lives only on the configured operated host (spec §DB/WAL). This change makes the authority's owner binding mean "this machine, with unbroken drain ownership". Another machine running the drain, or a restore, invalidates it, so cross-machine failover still needs a fresh operator approval.

## 8. Rollback cost

A code revert. The only new durable state is two `drain_meta` keys (`drain_owner_continuity`, `authority_transient_failures:<id>:<gen>`). The old code ignores them. No migration is needed either way.

## Conclusion

This fixes the live outage at its root causes and keeps every floor: PIN-only registration, no runtime self-registration or widening, immediate demotion on contract breaks, the spend cap, and re-approval on failover or restore. The live authority (generation 1) is already demoted, and only a PIN approval may restore it, so the operator approves once after this lands.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, read-only)
**Independent read of the artifact:** concern, then resolved

Round 1 raised a concern. On a store written before this change, (a) `noteDrainOwner` never persisted the tenure marker, so the run-history derivation ran forever, and (b) that derivation could not see a restore finalized before deploy, so an authority approved before the restore could become current again without a PIN approval. Separately, an `approveReady` `DrainConflictError` (an unauthorized promotion) would have counted as transient, where it used to demote.

Resolution: `noteDrainOwner` now persists the derived tenure on first write. The derivation treats the latest `restore` audit row as a tenure break, the same as a foreign run. `DrainConflictError` is grouped with contract violations and demotes at once. New unit tests cover marker persistence and a restore recorded before the marker existed. The reviewer found no self-registration or widening path and no lease-expiry risk (a heartbeat is sent right before the readiness await; the longest gap is about 65s, inside the 120s lease).

## Evidence pointers

- Live store (read-only): `drain_runs` run:a671f4cc (succeeded, 50 × `readiness-escalation`) and run:a49ad1e8 (degraded, `readiness-authority-failed`); `authority_posture` = proposal-only; judgment provenance `errorClass: CodexExecJsonTimeoutError`, latency 23306 ms.
- Replay against a copy of the live DB plus real `clusters.jsonl`: tenure derived as {m_03b30f…, sinceEpoch 22677}; `authorityOwnerCurrent` is true at 22679 and false for another host; the live timeout shape → posture stays active; the next tick reviews 50, 49 sent to the model, 1 escalated (the `execute.type:script` title).
- Tests: `tests/unit/feedback-factory/readiness-arbiter.test.ts`, `tests/unit/feedback-drain-store.test.ts`, `tests/integration/feedback-factory-drain-service.test.ts`, `tests/integration/feedback-drain-proxy-split-brain.test.ts`, `tests/e2e/feedback-readiness-authority-continuity.test.ts` (fails on the pre-fix sources, passes after), `tests/unit/PostUpdateMigrator-readinessBrakeWording.test.ts`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect: these are runtime code defects. The touched retry path is bounded: one attempt per 15-minute review, at most 3 consecutive before demotion, and each attempt must clear the daily spend reserve. Steady state is either success (counter cleared) or proposal-only (no further attempts until an operator approval).
