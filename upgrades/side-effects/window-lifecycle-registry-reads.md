# Side-Effects Review — window lifecycle registry reads

**Version / slug:** `window-lifecycle-registry-reads`
**Date:** `2026-10-31`
**Author:** `Echo`
**Second-pass reviewer:** `window_lifecycle_perf_review (independent subagent)`

## Summary of the change

`src/server/routes.ts` passes the already loaded window lifecycle ledger into the runtime registry and builds its obligation lookup once per synchronous evaluation. This removes repeated file reads while leaving session, commitment, driver-file, message, and evidence requery sources live. The change touches the existing runtime-proof evaluation path but introduces no new predicate or authority. The detector health integration test also polls less frequently and gives its real canary more scheduling room under suite load; it still requires a pass.

Tier 1: five files, 186 changed lines before this summary note. There was one independent review of the runtime change, no spec review round, and three full-suite attempts: an invalid test environment, a loaded detector timeout, then the green run. The extra attempts came from test setup and timing, not a change in the lifecycle decision rules.

## Decision-point inventory

- `runtimeRegistry` executor snapshot: pass-through — the same obligation IDs, deadlines, and window IDs are resolved from the ledger loaded by the caller.
- `materializeMachineEvidence`, admission, lifecycle tick, transition, and audit evaluation: pass-through — they use the same registry resolver with the caller's ledger.
- `evidenceAuthority.requery`: pass-through — it still reloads the ledger and validates the live evidence source for each record.

## 1. Over-block

A second process could replace the ledger on disk after a route loads it but before that synchronous evaluation finishes. The runtime registry would retain the caller's initial obligation metadata until the evaluation ends. Such an interprocess write could make one evaluation reject a newly valid obligation. The next evaluation sees the new ledger. No new predicate rejects a legitimate input under the normal single-writer route path.

## 2. Under-block

The same narrow concurrent-write window could let one evaluation see old obligation metadata while a second process changes disk state. The existing evidence requery still reads the current disk ledger and fails closed on mismatched proof. This optimization does not solve unrelated stale session or driver signals.

## 3. Level-of-abstraction fit

The optimization lives in the route that has already loaded the authoritative ledger. It changes repeated lookup construction, not the ledger store or the evidence authority. A global cache would require invalidation across writes and machines; a per-evaluation lookup avoids that new state.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no new block/allow surface.

The existing lifecycle evaluator and evidence authority retain every pass and block decision. The runtime registry still resolves live executor state; only its obligation lookup is reused within one evaluation.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The obligation lookup is an exact ID map of an already validated ledger.

## 5. Interactions

- **Shadowing:** Existing source freshness and evidence requery checks run as before; the lookup cannot skip them.
- **Double-fire:** No new event, timer, or action is added.
- **Races:** The lookup exists for one synchronous call only; it is never shared across requests. A separate writer may update the file during that call, as noted above.
- **Feedback loops:** None; the lookup is discarded after evaluation.

## 6. External surfaces

No API shape, message, persistent schema, or operator action changes. Other agents and users observe only faster evaluations. There is no new operator surface or mobile action; the UI checks are not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design:** each machine builds the lookup from the ledger it already loaded for its own current evaluation. No durable cache crosses the pool. The change emits no notice, holds no new durable state, and generates no URL.

## 8. Rollback cost

Revert the route change and ship a patch. No migration or agent state repair is needed. Users would see only the prior test and tick latency until the rollback arrives.

## Conclusion

The narrow per-evaluation lookup removes repeated ledger parsing without caching evidence authority. A broader cache was discarded because evidence rechecks must remain live. Ship after the final targeted test, full suite, and independent review pass.

## Second-pass review (if required)

**Reviewer:** window_lifecycle_perf_review (independent subagent)
**Independent read of the artifact:** concur

The lookup preserves synchronous single-writer authority decisions: runtime resolution still reads sessions, commitments, and driver files live, and evidence requery still reloads disk and verifies payload hashes. The existing production E2E covers admission, cadence, close, and a missing-commitment refusal. There is no focused concurrent-ledger-replacement test, so the cross-process stale-ledger window remains an explicit limit of this review.

## Evidence pointers

- Older-base exploratory M5 E2E: baseline 197.9 seconds; first narrow cache 153.5 seconds, both passing.
- Current-main commit `eebab6341` M5 E2E: baseline 194.1 and 193.2 seconds; final candidate 229.0, 146.9, and 145.1 seconds, all passing. The initial candidate outlier limits confidence in an across-suite throughput claim.
- M5 full suite: 53,836 unit, 4,991 integration, and 3,622 E2E tests passed. The lifecycle E2E file passed in 158.9 seconds. The detector health integration file passed in 62.2 seconds with its real canary reaching `pass`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller added — not applicable.
