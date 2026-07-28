# Side-Effects Review — WS5.2 Increment B / B2: dead-default eviction + correlated-outage floor (dark/unwired)

**Version / slug:** `ws52-incb-b2-default-eviction`
**Date:** 2026-06-13
**Author:** echo
**Second-pass reviewer:** not required at B2 (pure decision logic extending B1's unwired policy; no IO, no autonomous-write surface — the second-pass review attaches to B3 where the decision is actuated)

## Summary of the change

Extends `CredentialRebalancerPolicy.decidePass()` with §2.4's objective-0: keep `~/.claude` serving a healthy verified tenant. When the DEFAULT slot's tenant is needs-reauth/disabled OR the default slot is quarantined, the policy deals a healthy verified tenant into `~/.claude` (a `default-eviction` decision, highest priority — a frozen default freezes the operator's manual `claude`). Two bounded fallbacks: when verifiable slots exist but none is an eligible healthy tenant it SURFACES and does not act; when NO slot is oracle-verifiable (the correlated-outage signature) it applies the floor — preserve the default's last-known-good assignment, surface a degraded + attention entry, and perform NO eviction until the oracle returns. Adds two input fields (`desiredDefaultAccountId`, per-slot `lastKnownGoodAccountId`) and the `default-eviction` objective. Still pure, still unwired.

## Decision-point inventory

- `decidePass()` objective-0 branch — add — decides whether to rescue a dead/quarantined DEFAULT slot. A decision producer, not an authority (unwired). The eviction target is identity-verified-recent in the pure policy (B3's actuation re-verifies live before the move); the correlated-outage floor is the conservative direction (never empty/churn the default during an oracle storm).

---

## 1. Over-block
No block/allow surface. The conservative directions are deliberate: the correlated-outage floor refuses to act (preserve last-known-good) rather than risk dealing a dead tenant into the one slot that must stay alive; a dead default with no healthy tenant surfaces rather than forcing a bad move.

## 2. Under-block
Honest residual (§2.4 round-4): the floor's guarantee is "preserve the last KNOWN-GOOD assignment + surface", NOT "manual claude is certified live" — a correlated outage is observationally identical to "every grant died at once", and the oracle (the only liveness signal) is down by construction. The policy surfaces this explicitly ("NOT certified live") rather than over-claiming continuity. P19-capping of consecutive forced default evictions is B3 (stateful breaker), tracked there.

## 3. Level-of-abstraction fit
Correct layer — a pure extension of the B1 decision core. Objective-0 runs FIRST (before wall/drain) because a frozen default is the highest-impact freeze; the branch returns immediately when it acts or applies the floor, so it never races the other objectives.

## 4. Signal vs authority compliance
- [x] No — no block/allow surface; unwired, no authority (output not actuated yet). Deterministic policy over the same enumerable thresholds. (Ref: docs/signal-vs-authority.md.)

## 5. Interactions
- **Priority interaction:** objective-0 short-circuits the pass before objective-1/2/3. Correct — the default slot's liveness beats wall/drain optimization. It only fires when a default account is configured AND the default slot is genuinely dead/quarantined, so a healthy default is a pure no-op that falls through to the normal objectives.
- **Eligibility interaction:** the dead default tenant is (by design) excluded from `participatingSlots`; objective-0 reads the raw `slots` for the default specifically — the one place the quarantine-exclusion rule is intentionally overridden (only for `~/.claude`).
- No shadowing/race — pure, unwired.

## 6. External surfaces
None today (unwired). No API/config/agent-facing change. When B3 wires it, the only effect is the dark-gated, dry-run-first, oracle-verified, reversible swap the executor owns — plus the surfaced attention/degraded entries.

## 7. Multi-machine posture (Cross-Machine Coherence)
- **Machine-local BY DESIGN.** The default slot, its tenant, and the oracle answers are all per-machine; each machine keeps its OWN `~/.claude` alive from its own snapshot. No cross-machine input or coordination.

## 8. Rollback cost
Trivial. Revert the commit — the module is unwired, so no runtime behavior changes. No state, no migration, no credential touch (tests are pure).
