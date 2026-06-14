# Side-Effects Review — WS5.2 Increment B / B3a: the balancer orchestrator (dark/unwired)

**Version / slug:** `ws52-incb-b3a-rebalancer-orchestrator`
**Date:** 2026-06-13
**Author:** echo
**Second-pass reviewer:** independent reviewer subagent — CONCUR (this is the autonomous-write actuation orchestrator → Phase 5 required)

## Summary of the change

Adds `src/core/CredentialRebalancer.ts` — the stateful orchestrator that wraps the pure `decidePass()` core in a pass loop: on `tick()` it builds the read-only snapshot from injected providers, asks the policy for the zero-or-more swaps, and ACTUATES each through the injected `swap` dep (a wrapper over the gated CredentialSwapExecutor) — but only under the feature's dark/dry-run gate. It carries the hysteresis state the pure policy cannot (cooldown timestamps across passes) and the §2.4 P19 breaker (N consecutive LIVE failed swaps opens it; a success resets it; it self-heals by re-probing). Unwired: the server `setInterval` pass + the live `GET /credentials/rebalancer` status is step B3b.

## Decision-point inventory

- `CredentialRebalancer.tick()` — add — the autonomous balancer pass. This is the actuation layer (the decision was made in B1/B2). It actuates ONLY via `deps.swap()` (the gated, oracle-verified, staged executor) and ONLY when `isEnabled()` is true; even then the executor's own `dryRun` enforces no-write. The supervision is Tier-0 (§2.4): deterministic policy, oracle-verified reversible swaps, every pass audited.

---

## 1. Over-block
No block/allow surface. The conservative direction is dark = strict no-op (zero provider/executor calls when disabled) and the breaker (stop actuating after repeated failures).

## 2. Under-block
The breaker self-heals by re-probing rather than dead-latching — a deliberate choice (a transient keychain failure shouldn't permanently freeze the balancer); a persistent failure keeps it open every pass. The reviewer confirmed there is no path where an open breaker is never re-checked.

## 3. Level-of-abstraction fit
Correct: the orchestrator holds ONLY the cross-pass state (cooldowns, breaker, forced-override window) and delegates the decision to the pure policy and the write to the executor. It re-implements neither. The cooldown key (tenant-account pair) matches exactly what `decidePass`'s `cooldownOk` reads.

## 4. Signal vs authority compliance
- [x] Yes — but the logic is a deterministic policy evaluator (the §2.4 Tier-0 justification), and its authority to actuate is gated dark + dry-run-first + oracle-verified + reversible.

The orchestrator holds actuation authority, but it is the conservatively-bounded kind the spec sanctions: a deterministic policy over numeric thresholds, every swap reversible and oracle-verified by the executor, every pass audited, shipped dark + dry-run-first. (Ref: docs/signal-vs-authority.md; §2.4.)

## 5. Interactions
- **Executor interaction:** the orchestrator's ONLY write path is `deps.swap()`; a swap throw is caught and treated as `ok:false` (no crash), incrementing the breaker only on a LIVE failure. The executor enforces enabled/dryRun internally, so the orchestrator's gate + the executor's gate are belt-and-suspenders.
- **Cooldown/breaker state:** carried in-memory across passes; recorded by the tenant-account pair the decision exchanged (not the slot seat); NOT advanced on a failed swap (so the next pass retries). The forced-override window increments only on a successful wall-override and time-resets.
- **Reentrancy (latent, scoped to B3b):** `tick()` has no in-flight guard; overlapping ticks could double-read state. B3b (the `setInterval` wiring) MUST serialize ticks (skip-if-running) <!-- tracked: 20905 -->. Harmless at B3a (unwired; the unit tests call tick() sequentially).

## 6. External surfaces
None today (unwired). No API/config/agent-facing change. When B3b wires it, the only effect is the dark-gated, dry-run-first, oracle-verified, reversible swap the executor owns, plus the `GET /credentials/rebalancer` status read.

## 7. Multi-machine posture (Cross-Machine Coherence)
- **Machine-local BY DESIGN.** Each machine runs its own pass over its own keychain/quota snapshot; the in-memory cooldown/breaker state is per-machine-per-process. No cross-machine input or coordination (a credential has one home, on one machine).

## 8. Rollback cost
Trivial. Revert the commit — the module is unwired, so no runtime behavior changes. No state, no migration, no credential touch (tests use fakes). Any swap the wired balancer ever performs is the reversible, oracle-verified, dry-run-gated round-trip the executor owns.
