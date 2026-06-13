# Side-Effects Review — WS5.2 Increment B / B3b-snapshot: balancer snapshot mappers (dark/unwired)

**Version / slug:** `ws52-incb-b3b-snapshot-mappers`
**Date:** 2026-06-13
**Author:** echo
**Second-pass reviewer:** not required (pure stateless mappers, unwired, no IO, no decision/authority surface)

## Summary of the change

Adds `src/core/CredentialRebalancerSnapshot.ts` — pure functions translating the live system's state into the balancer's read-only pass snapshot: `mapAccount(s)`/`mapAccounts` (SubscriptionPool account → policy `AccountState`), `mapSlot(s)`/`mapSlots` (CredentialLocationLedger assignment → policy `SlotState`), `mapAccountStatus`, and `resolveRebalancerConfig` (clamp the configured knobs + derive cooldowns from the poll interval). These ARE the `listSlots`/`listAccounts`/`resolveConfig` providers the B3a orchestrator consumes; kept pure + out of server.ts so the units/sign translation (where a silent bug would mis-steer the balancer) is unit-testable. Still unwired — the server.ts construction + setInterval + live route is the next step.

## Decision-point inventory

- No decision point. These are stateless data mappers. The one judgment encoded — `rate-limited` maps to eligible (`ok`) — is a correctness requirement, not a gate: a walled account must stay eligible so wall-avoidance can rescue its slot (excluding it would strand the slot that needs help). Only `needs-reauth`/`disabled` (dead credentials) map to ineligible.

---

## 1. Over-block / ## 2. Under-block
No block/allow surface — not applicable. Conservative defaults: a missing quota reading maps to `measuredAt: 0` (epoch) → always stale → the account is SOURCE-only (never dealt in on a reading we don't actually have); a quarantined-empty slot (ledger `accountId: ''`) normalizes to a null tenant (can't be moved).

## 3. Level-of-abstraction fit
Correct: the mapping is the boundary between the live stores (SubscriptionPool, CredentialLocationLedger, config) and the pure policy. Putting it in its own pure module (not inline in server.ts) is the deliberate testability choice — the same reason the policy + orchestrator are pure.

## 4. Signal vs authority compliance
- [x] No — no block/allow surface; stateless mappers, no authority. (Ref: docs/signal-vs-authority.md.)

## 5. Interactions
- Consumed only by the B3a orchestrator's injected providers (and its tests). The cooldown derivation (per-pair = 1× poll interval, per-tenant = 2×) and stale-quota window (N poll periods) are computed here so the orchestrator/policy stay config-agnostic. No shadowing/race — pure.

## 6. External surfaces
None today (unwired). No API/config/agent-facing change.

## 7. Multi-machine posture (Cross-Machine Coherence)
- **Machine-local BY DESIGN.** The mappers read THIS machine's pool accounts + ledger; the resulting snapshot is per-machine. No cross-machine input.

## 8. Rollback cost
Trivial. Revert the commit — unwired pure functions, no runtime behavior, no state, no credential touch.
