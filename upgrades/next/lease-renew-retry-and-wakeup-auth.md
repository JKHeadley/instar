# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Three multi-machine fixes from the live two-machine checks on instar#2122 (tracking ACT-1308 and ACT-1306).

- **One unconfirmed lease renewal no longer costs the lease (ACT-1308).** `LeaseCoordinator.renew()` keeps the old expiry when a broadcast goes unconfirmed. With the default TTL (60s) = 2 × the renew interval (30s), the next regular tick landed on that expiry plus a few ms of timer drift, found `holdsLease()` false, and skipped without a word; `tickLease` shares the same gate on the same tick. Observed live on 2026-10-08, when the awake laptop lost the lease to its standby. The renew timer now retries an unconfirmed renewal after a quarter interval (7.5s at the default), repeating while it still holds the lease, and logs `lease renew skipped: still the named holder ...` once per episode if a lapse happens anyway. New read: `LeaseCoordinator.msSinceConfirmedRenewal()`. Behaviour when every renewal fails is unchanged: the monotonic self-fence still lapses the lease at TTL.
- **`instar wakeup` sees the live lease (ACT-1306 b).** It read the local `/health` without the agent auth token; an unauthenticated `/health` omits the `multiMachine` block, so the live-holder lookup added for instar#2122 always fell through to the registry. The read now sends `Authorization: Bearer <authToken>` (the token `loadConfig` resolves, including vault-externalized values).
- **A half-revoked registry row can be completed (ACT-1306 c).** `IdentityStore.revoke()` refused a row with `revokedAt` set but `status: 'active'` as "already revoked", so nothing could ever rewrite it. It now completes the revocation (status `revoked`, role `standby`), keeping the original `revokedAt`. A fully revoked row is still refused.

## What to Tell Your User

If you run me on two computers, the one in charge could lose its place after a single missed check-in, because the next check-in arrived a few milliseconds too late. It now tries again within seconds when a check-in is not confirmed. The command that hands control back to a computer now finds the computer actually in charge, and removing an old computer from the list now finishes properly.

## Summary of New Capabilities

- Lease renew retry after an unconfirmed renewal, plus a once-per-episode skip log.
- `LeaseCoordinator.msSinceConfirmedRenewal()`.
- `instar wakeup` authenticated live-holder lookup.
- `IdentityStore.revoke()` completes half-revoked rows.

## Evidence

- `tests/unit/lease-renew-unconfirmed-retry.test.ts` (5): real `MultiMachineCoordinator` + `LeaseCoordinator` + `HttpLeaseTransport` with fake timers; one unconfirmed broadcast then a retry keeps the lease past the old expiry plus 5ms drift; the contrast with the retry disabled lapses; no retry after a confirmed renewal; the skip log fires once; `stop()` cancels a pending retry.
- `tests/unit/wakeup-targets-awake-machine.test.ts`: the lookup sends the bearer token and finds the holder only on the authed branch.
- `tests/unit/machine-identity.test.ts`: a half-revoked row is completed with its original `revokedAt`.
