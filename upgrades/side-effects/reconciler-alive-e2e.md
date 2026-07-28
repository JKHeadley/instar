# Side-Effects Review — Tier-3 feature-alive E2E for the ownership reconciler

**Slug:** reconciler-alive-e2e
**Change:** Add `tests/e2e/pool-reconciler-alive-lifecycle.test.ts` (4 tests). Test-only;
no runtime/source changes. Completes the unit + integration + **e2e** three-tier coverage
required by the Testing Integrity Standard for the reconciler stuck-move fix.

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?
N/A — it's a test, not a gate. It asserts the real behavior (200 not 503, decision=transfer,
a tick converges). It cannot reject any production input.

## 2. Under-block — what failure modes does this still miss?
It does not re-run `server.ts`'s exact boot ordering (it wires AgentServer directly, like
the sibling pool-placement-transfer-alive E2E), so the specific boot-construction ordering
is NOT asserted here — that is covered by OwnershipReconciler.test.ts's late-bound-dep
regression tests. The comment states this honestly so the test isn't over-trusted. It also
exercises a single ownership registry (the route + the owner-side transfer), not the
cross-machine journal replication (covered by JournalSyncApplier + topic-pin-replication).

## 3. Level-of-abstraction fit — right layer?
Yes. Tier-3 "feature is alive" is exactly the missing tier for a feature with an API route.
It belongs in tests/e2e/ and mirrors the established pattern.

## 4. Signal vs authority compliance
N/A — a test holds no production authority. It only constrains CI.

## 5. Interactions — shadow / double-fire / race?
None. It binds an ephemeral port (47261) + a tmpdir, starts/stops its own AgentServer in
before/afterAll, and cleans up. No shared state with other tests.

## 6. External surfaces — visible to other agents/users/systems?
No. Test-only; no endpoint, config, or user surface. Marked internal-only in the release
notes (no runtime src change).

## 7. Multi-machine posture (Cross-Machine Coherence)
The test simulates the multi-machine reconciler decision (two machines in machines(), a
topic owned by SELF pinned to PEER) within one process — the standard way the e2e tier
proves a multi-machine feature is alive. It does not itself run on multiple machines (a
test never does); it asserts the convergence LOGIC the real multi-machine path relies on.

## 8. Rollback cost
Trivial — delete one test file. No migration, no state, no behavior change.
