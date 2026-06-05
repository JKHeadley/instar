# Side-effects review — commitment-unverifiable-stay-pending

## Change surface

1. `CommitmentTracker.isUnverifiableOneTime()`: drops the `beaconEnabled`
   carve-out (#656) — the generalized sweep no-op makes it redundant.
2. `verifyOne()`: the unverifiable-one-time branch returns null (stay pending)
   instead of mutating to terminal `delivered` with the trust note.
3. `backfillUnverifiableOneTimeActions()`: scoped to what its docstring always
   claimed — only rows with `violationCount > 0 && verificationCount === 0`.
4. Tests: 3 old-behavior pins updated (incl. #656's explicit "non-beacon is
   still auto-delivered" pin, deliberately inverted), full commitment +
   beacon suites green (157 + 13).

## What could this affect?

1. **Open-commitment growth** — unverifiable promises no longer self-close, so
   the active set grows until explicit deliver()/PATCH/expiry. This is the
   intended behavior (visibility + nagging IS the feature); the overdue sweep
   and commitment-check job exist precisely to surface them. Watch: agents that
   register many commitments and never deliver will now see them accumulate as
   open — honest, not silent.
2. **PromiseBeacon** — beacon-enabled commitments behave exactly as before
   (#656 semantics preserved through the general branch); 13/13 beacon tests
   green unchanged.
3. **The #76 violation-spam class** — cannot recur: the sweep branch is a
   no-op (no ticks of any kind), strictly quieter than the old auto-deliver
   (which fired onVerified once).
4. **onVerified consumers** — no longer receive a callback for trust-note
   auto-deliveries (there are none). Genuine verifications still fire it.
5. **Boot backfill** — historical violation-spammed rows still get drained
   exactly as documented; freshly-pending rows are no longer terminalized at
   restart (under 15-min restart churn this back-door alone would have undone
   the sweep fix within minutes).

## What this deliberately does NOT do

- No default `expiresAt` on unverifiable commitments (a candidate follow-up if
  pending-rot materializes; the overdue surfacing covers visibility today).
- No re-opening of already-evaporated commitments (terminal states stay
  immutable; CMT-1101's obligation is carried by a task-ledger entry).
- No route/API changes — POST /commitments behavior at registration unchanged.

## Rollback

Revert the PR. Old behavior (auto-deliver + boot terminalization) returns;
no data migration in either direction.
