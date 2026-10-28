# Side-Effects Review — Script result supervision foundation

**Version / slug:** `job-result-supervision-v2`  
**Date:** 2026-10-27  
**Author:** Echo  
**Second-pass reviewer:** `/root/supervision_side_effects_review` concurred for the dark foundation

## Summary of the change

This in-flight change records every production script attempt before execution,
stores its bounded result evidence and per-call audit durably, reconciles the
independent run-history census, and exposes coverage through `/jobs/triage`.
It also adds exact signed-certificate validation, a Jev judgment worker,
an outage-only replacement prompt and budget, an opt-in benchmark, migration
awareness, and tests. Both code-owned decision gates remain off. This review
covers scheduler admission, persisted state, model egress, and reporting.

## Decision-point inventory

- `JobScheduler.scriptRunnersActiveFor` — modify — refuses the script route on a persistent contract hold or read-only standby.
- `JobScheduler.runScriptRunnerJob` — modify — requires a durable attempt registration before launching a script.
- `JobSupervisionEvidence.projectSupervisionEvidence` — add — bounds and scrubs the model-visible projection; parser and size violations cannot be closed as routine.
- `JobFixedResultCertificate.decideFixedResult` — add — verifies two signatures, independent outcomes, current canary, and exact run snapshot before fixed closure.
- `JobSupervisionWorker` — add, dark — one Jev verdict per result, replacement only on Jev unavailability, with a pre-call audit and token reservation.
- `JobSupervisionStore` — add — serializes attempts, provider leases, grades, holds, and retry limits.
- `SqliteRegistry` — register the new long-lived WAL handle and unregister it on explicit close, so process exit closes the journal cleanly.
- `GET /jobs/triage` — modify — shows missing, unchecked, unresolved, graded, and provider-call counts; marks missing peer/history data incomplete.

## 1. Over-block

A valid script that emits so many declared anomalies that its projection exceeds
2,000 characters is held until repair, even if its result is otherwise useful.
A temporary SQLite write failure also sends future fires through the prior
session runner. At restart, a separate fsynced census boundary makes the
run-history comparison find missing, pending, or conflicting rows and persist
a slug hold. A failure before `recordStart` launched no script and created no
result to recover. These are deliberate integrity stops; the script route cannot
claim that it checked evidence it could not retain. The prior runner remains
the recovery path where one exists.
The process-wide SQLite close registry now owns the journal from the moment
its handle opens; an explicit store close unregisters it first. The constructor
also closes an opened handle if schema setup fails. Wiring tests verify both
normal close and failed construction, after CI caught the missing registration
on Node 20 and Node 22.

## 2. Under-block

The model decision gates remain off because the current synthetic benchmark
does not establish production accuracy, and the replacement provider is not
wired to a benchmark authority. The record-only path does not yet supply
pool-authoritative certificate replication or an isolated investigator. Those
missing elements cannot silently gain authority: code-owned gates keep fixed
and model closure inactive. An independent critical-anomaly notifier remains
on its existing path.

## 3. Level-of-abstraction fit

Durability and evidence-shape checks are code invariants at the scheduler and
store boundary. They do not try to judge whether a new result is healthy.
Jev receives only a bounded projection once the audit gate is opened; uncertain
results remain unresolved. Fixed closure is limited to signed, exactly
reviewed shapes. The coverage API reads run history as an independent census.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md).

- [x] No — the blocking checks enforce enumerable integrity invariants before a potentially unsafe script/model action.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic.

The hard stops are failed persistence, untrusted or truncated evidence, signed
certificate validity, and exhausted call budgets. None infer the meaning of
novel job content. New field and reason shapes are sent to judgment when the
decision gate is proven, and otherwise stay visibly unchecked.

## 4b. Judgment-point check

No static heuristic is added to a competing-signals meaning decision. The
fixed path requires an exact signed shape with independent graded outcomes;
new shapes go to the Jev judgment path. Jev uncertainty never becomes routine.

## 5. Interactions

- **Shadowing:** The old latest-per-slug model triage is dark, so it cannot issue a competing verdict. The existing anomaly notifier still emits independently.
- **Double-fire:** An attempt ID and provider epoch prevent two settled verdicts for one result; late provider answers are audit-only.
- **Races:** The attempt is registered before execution and completed before claim release. A failed history append marks coverage incomplete and holds the route. The standby checks prevent a read-only process from opening a writable journal.
- **Feedback loops:** Retry is bounded by call count and 24 hours; budget refusals retry every 10 minutes so Jev recovery can clear them without a model-call loop.

## 6. External surfaces

The new SQLite journal and canary assertion log persist under the agent state
directory. `/jobs/triage` gains an additive `supervision` object and a
content-free call audit. Existing scripts may fall back to their prior runner
after a durable write or contract failure, and an attention item identifies
the affected slug. The opt-in benchmark sends only synthetic structured cases
to Jev or an explicitly selected provider and keeps its local audit journal.
No operator-facing action is added; no dashboard form is touched.

## 6b. Operator-surface quality

No operator surface — not applicable. The existing read API gains additive
data; its user-facing wording is unchanged.

## 7. Multi-machine posture

**Machine-local by design**, with a **proxied-on-read** pool view. Each machine
owns the attempts and model calls it executed; `/jobs/triage?scope=pool` merges
attempt IDs and marks peer failures or conflicting rows incomplete. It also
reports incomplete coverage whenever a seven-day expected-machine roster is
unavailable or a listed machine vanishes from discovery. The current server
does not yet provide that roster, so pool accuracy is intentionally unavailable.
The local
write journal cannot be shared across concurrent executors. The future
certificate and fallback-reservation authorities must be pool-owned before
decision activation. Attention items use the existing Telegram attention
surface; no URLs are generated. Topic transfer does not move a machine's
historical attempt journal, so the pool view retains it on the owning machine.

## 8. Rollback cost

The model route is dark, so a code rollback restores the old runner and leaves
only an unused SQLite audit file plus additive response fields to age out.
Script route holds are persisted after the independent census detects a lost
write at restart; repair or rollback must explicitly release them after
checking the affected job. Existing config values are preserved.
No destructive database migration is required to remove the feature.

## Conclusion

The review found a standby write hazard, a late-response authority race,
silent evidence truncation, a restart durability gap, a vanished-peer accuracy
gap, and a 24-hour abandoned-run delay. Each is now covered by a focused test;
process-owned-run reconciliation handles abandoned local runs on the next
30-second pass when the current process no longer owns them. Cross-machine
claim recovery remains an activation prerequisite. The run-start gate state is
now persisted as a readable field, and the model queue excludes dark-era rows
even if a later rollout opens. The current code is suitable for merge as a
record-only foundation with both decision gates dark. It is not ready for an
active model rollout.

## Second-pass review (if required)

**Reviewer:** `/root/supervision_side_effects_review`  
**Independent read of the artifact:** Concur for draft PR with both decision gates dark; activation prerequisites above remain

**SQLite lifecycle follow-up:** The reviewer found that registering only after
schema setup left a leak on migration failure. Registration now happens
immediately after open, with a close-on-failure test. The reviewer reread the
diff and concurred with the correction; no further safety concern was found.

## Evidence pointers

- `docs/specs/job-result-supervision-v2-benchmark-evidence.md`
- `tests/unit/job-supervision-store.test.ts`
- `tests/unit/job-cost-runner/JobScheduler-script-runner.test.ts`
- `tests/e2e/job-cost-lifecycle.test.ts`

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action`: guard. The new census and provider-retry loops are
registered in `src/testing/selfActionRegistry.ts`. The convergence ratchet at
`tests/unit/self-action-convergence.test.ts` drives permanent failure and
restarts: one recovered census row per run ID, at most three audited provider
calls per result. Durable row uniqueness and `call_count` are the brakes;
the 24-hour result expiry is an additional limit. The timers poll at 30 and
five seconds, respectively, without re-executing the script.
