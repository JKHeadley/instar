# Side-Effects Review — Silent-standby git-less lease (observe-only + legacy-key fallback)

**Version / slug:** `silent-standby-lease`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Two narrowly-scoped fixes for bugs #4 + #5 of the multi-machine live-transfer
cascade:

1. `MachineIdentity.loadSigningKey()` — on ENOENT for the canonical
   `signing-key.pem`, fall back to the legacy `signing-private.pem` if present,
   else rethrow. (The mini's key was under the legacy name; the lease setup threw
   at boot, so the `LeaseCoordinator` never attached and the mini never resolved a
   holder.)
2. `MultiMachineCoordinator` — new `isLeaseObserveOnly` getter
   (`multiMachine.telegramPolling === false`). A silent standby skips
   `acquireIfEligible`/`renew` in both `initializeLease` and `tickLease`; it only
   reconciles its role to whatever lease it observes. It never holds its own lease,
   so with the git-less `LocalLeaseStore` (no shared CAS) it can't leapfrog the
   primary's epoch and reject the primary as `below-git-floor`.

## Decision-point inventory

- **loadSigningKey fallback branch** — ENOENT on canonical → try legacy name →
  exists? read it : rethrow original. Both sides covered by unit tests.
- **isLeaseObserveOnly gate** — true (telegramPolling:false) → observe-only path
  (no acquire/renew); false/undefined → unchanged acquire+renew path. Both sides
  covered by unit tests (silent standby never acquires; normal machine does).

## 1. Over-block

**What legitimate inputs does this change reject?** A silent standby
(`telegramPolling:false`) no longer acquires a lease at all — so it can never
become awake on its own. That is the INTENT: a muted standby that became "awake but
not serving" is the incoherent state we are removing. A machine that should be able
to take over sets `telegramPolling:true` (or unsets it), which is the unchanged
acquire path. The key fallback rejects nothing — it only ADDS a second lookup
location before the same rethrow.

## 2. Under-block

**What does this still miss?** It does not add auto-failover for a silent standby
(out of scope — failover for it is a deliberate un-mute). It does not add a shared
CAS to `LocalLeaseStore`; the split-brain is avoided by not acquiring rather than
by making git-less acquisition safe (correct for the one-awake-machine model; the
active-active pool, which needs real shared CAS, remains git-backed). The key
fallback covers only the one known legacy name (`signing-private.pem`), matching
the lifeline loader's existing fallback — not an open-ended search.

## 3. Level-of-abstraction fit

**Right layer?** Yes. The key fallback lives in the single `loadSigningKey()`
loader that every lease/transport consumer already calls (one chokepoint). The
observe-only gate lives in `MultiMachineCoordinator`'s two lease entry points
(`initializeLease`, `tickLease`) — the only places acquisition is decided — derived
from the same `telegramPolling` flag that already designates a silent standby
elsewhere. No new config surface, no duplicated rule.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No blocking authority added. The observe-only gate REMOVES an action (acquisition)
for a configured-silent machine; it never blocks a message or an operation. The key
fallback is a pure read-path widen with an unchanged terminal rethrow. Neither path
gates any user-facing or outbound behavior.

## 5. Interactions

`loadSigningKey` feeds `HttpLeaseTransport` (lease broadcast/observe) and
machineAuth signing; widening it only makes a previously-throwing legacy-keyed
machine succeed — no consumer sees a different value, only a present-vs-throw
difference. The observe-only gate interacts with `reconcileRoleToLease` (still
called every tick, now inside each branch) and with `LeaseCoordinator.effectiveView`
(a standby with an empty `LocalLeaseStore` folds the primary's observed broadcast
cleanly). Idempotent: both paths produce the same result on repeated boots/ticks.

## 6. External surfaces

No HTTP routes, no config defaults, no notifications, no Telegram. `/health`'s
`multiMachine.syncStatus.leaseHolder` will now correctly resolve to the primary on a
silent standby (the visible, intended effect). Pure code.

## 7. Rollback cost

Low. Revert the PR: `loadSigningKey` returns to canonical-only (re-bricks a
legacy-keyed machine's lease setup) and the coordinator returns to always-acquire
(re-introduces the split-brain on git-less standbys). No schema, no migration, no
persisted state created by this change. The one deploy-time action (clear the mini's
stale self-issued `lease-local.json`) is a one-shot cleanup, not a rollback cost.

## Conclusion

Minimal, additive-or-removing-an-action change with both decision sides unit-tested,
no new authority, no external surface beyond a corrected `/health` field, and a cheap
revert. It closes the final two layers blocking the live two-machine transfer.

## Second-pass review (if required)

Not required — no new blocking authority, no destructive op, both decision branches
covered by tests, reversible. (Live two-machine transfer proof is the Tier-3 gate
that follows deploy.)

## Evidence pointers

- `tests/unit/machine-identity.test.ts` — loadSigningKey legacy fallback + still-throws.
- `tests/unit/multi-machine-coordinator.test.ts` — observe-only never acquires/renews;
  normal machine acquires; `isLeaseObserveOnly` reflects the flag.
- 109 related unit tests green (machine-identity, coordinator, LeaseCoordinator,
  mesh-signing-key-resolution, multimachine-syncstatus); `tsc --noEmit` clean.
- Spec: `docs/specs/silent-standby-lease.md` (+ `.eli16.md`).
- `upgrades/NEXT.md` — upgrade guide.
