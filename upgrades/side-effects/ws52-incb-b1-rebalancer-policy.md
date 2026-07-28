# Side-Effects Review — WS5.2 Increment B / B1: the balancer decision core (dark/unwired)

**Version / slug:** `ws52-incb-b1-rebalancer-policy`
**Date:** 2026-06-13
**Author:** echo
**Second-pass reviewer:** not required at B1 (pure decision logic, unwired, zero IO, no autonomous-write surface — the second-pass review attaches to B3, where the decision is actuated through the live executor under the dark gate)

## Summary of the change

Adds `src/core/CredentialRebalancerPolicy.ts` — the §2.4 "stock-trader loop" decision core as a PURE function `decidePass(input) → { decisions, degraded, attention, noActuationReason }`, plus exhaustive unit tests. Given a read-only snapshot (per-account quota + reset proximity, per-slot tenancy/verify/activity, cooldown state, resolved+clamped config) it computes the zero-or-more swap decisions for one pass: objective-1 wall avoidance + the bounded wall-override, objective-2 use-it-or-lose-it drain, eligibility, and the hysteresis floors. It performs NO IO and holds NO authority — it DECIDES; the actuator (step B3) routes an accepted decision through the Step-5 executor under the dark/dry-run gate. This is the first of Increment B's steps (B2 = dead-default eviction + correlated-outage floor + quarantine-exit + P19 breaker + scheduled identity audit; B3 = wiring/actuation/routes; B4 = integration/e2e/livetest), sequenced so the entire policy is testable before any autonomous write exists.

## Decision-point inventory

- `decidePass()` — add — the per-pass swap policy. It is a DECISION producer, not an authority: it returns proposed swaps + surfaced terminal states. Nothing actuates on its output yet (unwired). When B3 wires it, actuation is gated by `subscriptionPool.credentialRepointing.enabled` + `dryRun` and verified by the oracle (the Tier-0 justification, §2.4: deterministic policy over enumerable numeric thresholds, every decision audited, reversible swap verified by the oracle).

---

## 1. Over-block
No block/allow surface. The nearest analog — refusing to emit a swap — is the conservative direction (a withheld swap is a no-op; the spec's "a pass with no actuation performs zero keychain/CLI operations" invariant). Concretely conservative: stale-quota accounts are SOURCE-only (never dealt in, lest stale headroom mask a wall); ineligible (needs-reauth/disabled/quarantined/unverified) tenants never participate; a critical slot whose override is blocked WAITS rather than being non-forced-rescued.

## 2. Under-block
The honest residual the spec names (§2.4 round-4): the wall-path recency gate NARROWS but does not CLOSE the "target passed its last audit then died after it" window — a just-died-but-recently-verified target can still be dealt into a walling slot, bounded to "victim slot quarantined + one re-auth, surfaced". B1 implements the recency gate (a target must be verified within the audit cadence and non-divergent); the residual is accepted per the spec's oracle-split rationale, and the post-commit verify (B3, via the executor) is the backstop.

## 3. Level-of-abstraction fit
Correct layer, and the deliberate point of B1: the policy is split OUT of the actuation so every threshold/cap/cooldown is unit-testable without a keychain (the same fake-deps discipline as the executor). It consumes already-resolved+clamped config (the resolver lives in B3) so the pure core never reads raw config or clamps.

## 4. Signal vs authority compliance
- [x] No — this change has no block/allow surface and, at B1, no authority at all (its output is unwired).

The policy is a deterministic evaluator over numeric thresholds; the authority to actuate is B3's and is gated dark + dry-run-first + oracle-verified. (Ref: docs/signal-vs-authority.md; §2.4 Tier-0 supervision justification.)

## 5. Interactions
- **Hysteresis interactions (designed, tested):** 1-swap-per-pass for non-forced objectives; the wall-override may emit up to `maxForcedSwapsPerPass` and bypasses cooldowns but is itself bounded by the fresh-data gate (no re-fire on the same sensor snapshot) and `maxForcedOverridesPerWindow` (exhaustion → surfaced terminal state, never a loop). Per-pair + per-tenant cooldowns both key on the ACCOUNT pair/tenant (consistent basis; the per-tenant cooldown is what defeats the 3-way rotation attack pairwise cooldowns miss). Drain carries a per-slot "drain in progress" hold so the 3-way drain rotation can't fragment the very window it means to use.
- **Priority interaction:** wall (forced) short-circuits the pass; otherwise non-forced wall → drain → default-preference, one swap max. A critical slot is never downgraded to a non-forced rescue in the same pass.
- No shadowing/race — the module is pure and unwired; nothing else calls it.

## 6. External surfaces
None today (unwired). The module changes no API, no config, no agent-facing surface. When B3 wires it the only external effect is the (dark-gated, dry-run-first, audited, oracle-verified, reversible) credential swap the executor already owns.

## 7. Multi-machine posture (Cross-Machine Coherence)
- **Machine-local BY DESIGN.** The balancer permutes THIS machine's credential slots based on THIS machine's quota/activity snapshot. Each machine runs its own pass over its own keychain; there is no cross-machine input or coordination (a credential has exactly one home, on one machine, §0.d). No replication, no proxied read, no generated URL.

## 8. Rollback cost
Trivial. Revert the commit — the module is unwired, so no runtime behavior changes. No state, no migration, no credential touch (tests are pure). Any swap the wired balancer (B3) ever performs is the reversible, oracle-verified, dry-run-gated round-trip the executor already owns.
