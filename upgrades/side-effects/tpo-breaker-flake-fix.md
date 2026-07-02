# Side-Effects Review — tpo-breaker-flake-fix

**Change:** test-only. `tests/unit/TopicProfileOrchestrator.test.ts` — the five §10.4 circuit-breaker tests waited on `parkedFor('7') !== null`, an intermediate state `parkAndRevert` makes visible before its internal `flushDurably` await yields; under CI load the 10ms poll observed the park and asserted on trip effects (unpark / audit / disclosure) that had not run yet. They now wait on the `breaker-revert` audit — the trip's terminal signal, emitted after every other synchronous trip side-effect — via a shared `waitForBreakerTrip(h)` helper. No `src/` file touched.

1. **Over-block** — none. No runtime decision surface; the tests assert the same behavior with a later, race-free synchronization point.
2. **Under-block** — none. Coverage is unchanged: every assertion that existed still runs (including `parkedFor` non-null, asserted explicitly after the wait). The wait is stricter, not looser — it requires the full trip, not just the park.
3. **Level-of-abstraction fit** — considered fixing the production ordering instead (assign `entry.parked` after `flushDurably`). Rejected: the mid-trip visibility is harmless in production (no production consumer polls `parkedFor` during a trip; the store lock serializes real readers), and reordering durable-write vs in-memory state has its own failure-mode tradeoffs (a crash between write and assign). The test was the thing making a timing assumption; the test is the right layer to fix.
4. **Signal vs authority compliance** — n/a; no decision point, no gate, no blocking authority. Test-only.
5. **Interactions** — the helper waits on `h.audits`, which each test's fresh harness resets, so no cross-test bleed. The two tests that subsequently call `requestRecoveryWrite` also benefit (they previously raced `durable.breakerTrips` being set mid-trip).
6. **External surfaces** — none. Nothing visible to agents, users, or other systems changes.
7. **Multi-machine posture** — n/a (test-only; no state, no replication surface).
8. **Rollback cost** — `git revert` of one commit restores the old waits; zero data or fleet impact.

**Evidence:** old code failed iteration 1 of a 15-run local loop (same assertion as CI shard 2/4 failures on PR #1320 tonight, twice); fixed code passed 25 consecutive runs under benchmark load on the same machine.

**Second-pass review:** not required — no sentinel/gate/lifecycle runtime code touched (test file only).
