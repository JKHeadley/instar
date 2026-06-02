# Convergence Report — Multi-Machine Lease Robustness (#680)

**Spec:** `docs/specs/MULTI-MACHINE-LEASE-ROBUSTNESS-SPEC.md`
**ELI16:** `docs/specs/multi-machine-lease-robustness.eli16.md`
**Author:** echo · **Rounds:** 3 · **Date:** 2026-06-02
**Cross-model review:** unavailable (codex CLI not installed in this environment; recorded honestly, not fabricated)

## Summary

Three convergence rounds (5-reviewer internal panel: security, scalability, adversarial, integration, lessons-aware) ran against this spec. The value of converging-before-building was concrete: **two distinct load-bearing consensus-correctness flaws in Problem A's lease design were caught and fixed before any code was written.** Each would have shipped a non-converging multi-machine fix.

## Round 1 — caught the zombie-holder flaw (HIGH, all 5 reviewers)

Problem A as first written ("the loser stops self-renewing") does **not** converge. Code-traced: a loser that merely stops renewing remains a **zombie-holder** — `holdsLease()` judges its own expiry on a monotonic-local clock, so it still believes it holds for a full `ttlMs`. Meanwhile the winner, already at epoch N, only *renews* N — it never calls `buildAcquisition` (the sole epoch-advance path, `FencedLease.ts:215`), so it never fences the loser at N+1. Both sit at N: no single-holder fixpoint.

**Fix direction:** the loser must *actively relinquish* (not just stop renewing), and the winner must advance to a strictly-higher epoch.

## Round 2 — caught the headless-loser flaw (HIGH, security/adversarial/integration)

The Round-1 correction ("loser relinquishes, winner stays at N") **still** does not converge. Code-traced: `effectiveView()`'s tunnel-fold adopts a peer lease only on a **strict `>`** epoch (`LeaseCoordinator.ts:189`). A same-epoch (N) winner is therefore never adopted — the relinquishing loser goes **headless** (recognizes no holder) instead of adopting the winner. `holdsLease()` is false but `currentHolder()` still names the loser's own stale local-store record: a quieter split-brain, not convergence.

**Fix (v3, applied):** the loser relinquishes (clears `selfIssued` + forces its persisted `lease-local.json` to read expired — which *also* unblocks the winner's `canAcquire()` from returning `held-by-live-peer`) **AND** the winner advances **once** to N+1 via `buildAcquisition`. The loser then adopts winner@N+1 through the existing strict-`>` fold (N+1 > N). Single holder at N+1; epoch stops climbing.

## Round 3 — design CONVERGED (with an honest caveat on the votes)

Round 3 verified the v3 design. **All 4 reviewers voted `v3_converges=false` — but every one of those votes reduces to "v3 is not implemented in the source code yet."** That is the expected state of a pre-build spec, and it was an artifact of the round's review prompt instructing reviewers to "code-verify against the actual source" (a docs-only branch). Reading all four reviews in full, **no reviewer found a genuine NEW design flaw** — and the one finding that actually traced the logic (the CAS analysis) *confirmed* the design: "the logic chains correctly, but depends on selfIssued being cleared" — exactly what the spec specifies.

This report does **not** claim "4 reviewers confirmed convergence." It claims: the v3 **design** is internally consistent and reaches a single-holder N+1 fixpoint (independently traced); the spec **names** every new mechanism it requires (the tie-break comparator to ADD, the relinquish API to ADD, the winner-advance path, the per-episode latch, the K-cycle escalation); and the relied-upon primitive (`buildAcquisition`) exists. The reviewers also surfaced an excellent build implementation-map (the exact methods + wiring points), captured in `CONVERGENCE-FINDINGS.local.md`.

**The empirical convergence proof is Problem A's unit test** — the in-memory two-coordinator harness asserting the loser's `currentHolder() === winner@N+1` and that the epoch stops climbing. That test is ground truth; if the design does not converge, the test fails and the design is iterated.

3 optional polish edits were applied (none were blockers): named the concrete relinquish API; required `__resetSqliteRegistryForTests()` to clear the closed-set; added a 3+ machine same-epoch transitivity test bullet.

## Problem B (SQLite close registry)

Reviewers tightened: the precise long-lived store set is **15** (a 15th — `SemanticMemory` — is constructed via an injected factory and is invisible to a `new Database(` grep, so the wiring-integrity test must enumerate the allowlist explicitly, not count callsites). ~9 of 15 stores lack a per-close idempotency flag, making the registry's at-most-once closed-set + per-handle try/catch load-bearing. Close-order: WAL checkpoint/flush before close; close last, after writer-stops; cover every `process.exit()` path.

## Process lesson (recorded)

A spec-convergence workflow must frame reviewers to review the **design** (assuming named mechanisms are built), NOT "code-verify against source" — the latter guarantees false "not implemented" blockers for a pre-build spec, and produces a shared-blind-spot failure across same-model reviewers. The bundled `/spec-converge` skill handles this; the hand-rolled Round-3 workflow re-introduced it.

## Sequencing

B (SQLite close-on-exit) first — a crash-looping holder makes the lease election un-observable — then A (lease convergence), each a gated PR with the unit tests above, then live two-machine failover proof + §7b real-Telegram test-as-self.
