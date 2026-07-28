# Side-Effects Review — Apprenticeship registry integrity

**Version / slug:** `apprenticeship-registry-integrity`
**Date:** `2026-07-15`
**Author:** `Instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

Cycle writes in `src/server/routes.ts` now resolve their `instanceId` through `ApprenticeshipProgram` and require an active instance. `ApprenticeshipProgram` adds retained terminal `abandoned`, reachable only from pending. A bounded read-only integrity route reports historical dangling cycle rows. Capability discovery, fresh scaffolds, existing-agent migration, and all three test tiers carry the same semantics.

## Decision-point inventory

- Cycle-record referential integrity — modify — deterministic invariant: evidence of live work must name an existing active registry instance.
- Pending-instance disposal — add — deterministic lifecycle transition from pending to retained terminal abandoned.
- Historical integrity read — add — observation only; it never repairs or deletes rows.

## 1. Over-block

The active-only rule intentionally rejects cycles for blocked instances. A caller that previously treated blocked as “active but paused” must resume the instance before recording more work. This is intended because a cycle is evidence that work occurred; accepting it while paused would contradict the registry. Pending, complete, and abandoned rejection is similarly intentional.

## 2. Under-block

The check guarantees existence and current active status at record time, but it does not add a cross-store transaction. A concurrent status transition could theoretically occur between the registry read and SQLite cycle insert. The server is currently single-process and both operations are synchronous, so there is no await/yield point in that interval. Multi-process writers remain outside the stores' existing guarantees.

The integrity report scans the public 500-row read ceiling. Its `truncated` flag explicitly warns when the ceiling is reached; callers may need direct store inspection for a larger legacy population.

## 3. Level-of-abstraction fit

The registry owns lifecycle truth, while the cycle HTTP route owns the composition between registry and cycle store. Validation belongs at that composition boundary rather than inside the cycle store, which remains usable for loading and honestly auditing legacy rows. The transition table remains the single owner of lifecycle legality.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this is hard-invariant validation over an enumerable state machine, one of the principle's explicit exceptions.

The rule does not infer conversational meaning or weigh competing signals. Registry membership and the five statuses are complete structured facts, so deterministic rejection is the appropriate authority.

## 4b. Judgment-point check

No new static heuristic exists at a competing-signals decision point. “Cycle evidence requires active lifecycle state” and “abandoned is pending-only and terminal” are enumerable invariants, not judgment candidates.

## 5. Interactions

- **Shadowing:** registry validation runs after the existing request-shape and transcript-audit checks but before persistence. Existing anti-fabrication errors remain observable for otherwise valid active instances.
- **Double-fire:** no second component repairs or deletes dangling rows; the new report is read-only.
- **Races:** no asynchronous boundary exists between the synchronous registry lookup and synchronous record call.
- **Feedback loops:** none; reports do not actuate lifecycle or cycle state.

## 6. External surfaces

API callers now receive a 400 for unknown or inactive instance references. The transition API accepts `abandoned` and returns the retained record. Capability discovery exposes the integrity endpoint. Fresh and migrated agent instructions teach all three behaviors. Persistent instance state may now contain `abandoned`; existing readers use the shared status type or return opaque JSON. No external service is contacted and no operator-facing dashboard action is added.

## 6b. Operator-surface quality

No dashboard, approval page, or operator form is changed — not applicable.

## 7. Multi-machine posture

**Machine-local by existing store design:** both the apprenticeship instance registry and cycle SQLite store live in the agent's local state directory today; this PR preserves that established scope and makes their local relationship coherent. It does not introduce notices, URLs, replication, or topic-transfer behavior. On multiple machines, each machine validates against its own co-located registry/store pair; no new cross-machine divergence is created by this change.

## 8. Rollback cost

Code can be reverted in a hot-fix release. Existing `abandoned` records must not be deleted; a rollback reader that predates the status will still load the JSON record but cannot transition it, which is safe because it is terminal. No cycle rows are mutated by the report, so no cycle-data migration or repair is required.

## Conclusion

The stricter rule closes the phantom-reference path at the correct composition boundary, preserves audit history through retained abandonment, and exposes legacy damage without inventing repairs. The principal compatibility cost—callers must activate instances before recording cycles—is the intended lifecycle contract. Clear to ship.

## Second-pass review

Not required: this does not touch messaging, session lifecycle, dispatch, recovery, trust, coherence, or heuristic guard/sentinel authority.

## Evidence pointers

- `tests/unit/apprenticeship-program.test.ts`
- `tests/unit/PostUpdateMigrator-apprenticeshipRegistryIntegrity.test.ts`
- `tests/integration/apprenticeship-routes.test.ts`
- `tests/e2e/apprenticeship-lifecycle.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller — not applicable.
