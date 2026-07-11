# Side-Effects Review — Two-Node Replication Harness (Increment-2 Entry Gate)

**Version / slug:** `two-node-harness-increment2-entry-gate`
**Date:** `2026-07-11`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `not required (tests + test-support only; no decision point, no runtime surface)`

## Summary of the change

Implements the Increment-2 entry-gate deliverable of `docs/specs/ownership-gated-spawn-and-judgment-within-floors.md` (§4 line 242: "Entry gate: the two-node replication harness (§5) green in CI"; §5 line 261: the L7 evidence contract). Two new test files only: `tests/support/twoNodeOwnershipHarness.ts` (the reusable two-node factory — durable ownership substrate, un-stubbed signed journal-sync replication, real AgentServer per node) and `tests/e2e/duplicate-reconciliation-two-node.test.ts` (the entry-gate lifecycle + the §5 delayed-replay and partition-formed cases + three spec-anchored `it.todo` scenarios). Plus this artifact, the ELI16 companion, and an internal-only release fragment. **Zero `src/**` changes.**

## Decision-point inventory

*(none — no runtime decision point is added or modified; the harness exercises existing ones)*

## 1. Over-block

Nothing at runtime (no runtime surface). In CI: the new E2E becomes a required-passing test — a future change that breaks the two-machine heal fails CI. That is the deliverable, not a side effect: the spec makes this test THE Increment-2 entry gate.

## 2. Under-block

- The harness runs two nodes IN ONE PROCESS over loopback — partitions are modeled as WITHHELD replication (the §5 partition-formed and delayed-replay cases), not as packet loss/timeout dynamics; clock skew and cross-host filesystem differences are not modeled. The spec's §3.0 consistency contract owns those honesty bounds.
- The 2b custody-transfer scenario and the terminate-time-probe scenario are `it.todo` — their mechanics are deliberately NOT built in Increment 1/this PR (Increment 2b's own build); the todos carry the spec anchors so they cannot be silently forgotten.
- The closeout leg asserts the ARMING predicate (the peer's own view says owner-elsewhere) and simulates the close; the full sweeper-close leg lands with the `duplicate-reconciled` reap-reason extension (Increment 2).

## 3. Level-of-abstraction fit

Reuses the three existing proven patterns (journal-sync-roundtrip's replication hop, mesh-failover's two-server shape, the alive-test's real-AgentServer boot) rather than inventing a parallel harness idiom. The node factory lives in `tests/support/` alongside the existing fixture module.

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md — Not applicable at runtime (no new detector or authority). In-CI authority (a failing test blocks merges) is the standard test-suite contract.

## 5. Interactions

- The E2E rides the existing `e2e` CI job (vitest include already covers `tests/e2e/**`) — no workflow changes, no new CI lanes.
- The harness binds ephemeral loopback ports (port 0) and tmpdir state — no interaction with the host agent's server, state, or config.
- Discovered interaction (already resolved upstream): building this harness surfaced the record-already-correct FSM refusal (claim-out-of-sequence → escalate-instead-of-heal) — fixed on the Increment-1 PR as the `record-already-converged` skip and unit-tested there; this E2E now proves that fix end-to-end.

## 6. External surfaces

None. No egress (loopback only), no persistent state outside vitest tmpdirs (SafeFsExecutor teardown), no operator surface, no agent-visible capability (hence the internal-only release-note lane).

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

The change IS the multi-machine test substrate. It runs no agent, replicates no store of its own, and creates no cross-machine surface; it simulates two machines inside one test process to verify the production replication contract (journal → signed envelope → applier → materialized peer view).

## 8. Rollback cost

Delete the two test files (plus docs). Nothing depends on them at runtime. The only cost of rollback is losing the Increment-2 entry gate's objective checkability.

## Rollout-ladder compliance (§4 hard prohibitions)

- NO flag flips: `ownershipGatedSpawn` / `duplicateReconciler` / `judgmentArbiters` / `commitmentCustodyTransfer` untouched; `inboundQueue` / `holdForStability` / stale-owner-release untouched (their own features' graduation decisions, per §4 "inherit-and-stall").
- NO `provenance.deterministicSampling` change (that is an Increment-2-ENTRY action, riding the actual enforce-flip PR).
- In-test enforce-mode construction of the reconciler is test construction inside a sandbox, not a rollout-ladder flip (the Increment-1 burst-invariant E2E precedent).

## Conclusion

Tests + test-support only; the risk surface is CI-time, which is the point. Clear to ship as its own PR once Increment 1 merges (it depends on the Increment-1 modules).
