# Side-Effects Review — lease renewal retry, authenticated wakeup lookup, half-revoked row repair

## Summary of the change
Three small fixes found while bringing Luna onto two machines (instar#2122, ACT-1306 b/c, ACT-1308), under the approved spec `docs/specs/lease-unconfirmed-candidate-flap.md`:
1. `MultiMachineCoordinator` arms a one-shot retry at a quarter of the renew interval after an UNCONFIRMED renewal, instead of waiting a full interval that lands on the old expiry plus timer drift. A skipped renew tick while this machine is still the named holder now logs once per episode. New read-only getter `LeaseCoordinator.msSinceConfirmedRenewal()`.
2. `instar wakeup` sends the agent auth token on its local `/health` read, so the live lease holder is actually seen; a token that gets the anonymous answer is logged, then the registry fallback is used as before.
3. `IdentityStore.revoke()` completes a half-revoked row (revokedAt set, status active) instead of refusing it, keeping the original revokedAt.

## Decision-point inventory
- Renew tick gate (`holdsLease()`): unchanged. Only adds a log line and a retry timer after an attempt.
- Retry arming: only when still holding the lease and the last confirmed renewal is older than half an interval.
- Wakeup holder lookup: unchanged decision, now with credentials on the read.
- Revoke refusal: narrowed from `status === 'revoked' || revokedAt` to `status === 'revoked'`.

## 1. Over-block
None added. The revoke change removes a refusal that blocked a legitimate repair.

## 2. Under-block
Revoke now proceeds for a row with revokedAt but status active. That row was already intended as revoked; completing it cannot revoke a machine the operator did not name, and the call is still the operator's `machines remove`.

## 3. Level-of-abstraction fit
The retry lives in the coordinator's renew loop, which already owns renew cadence. LeaseCoordinator gains only a read. No new layer.

## 4. Signal vs authority compliance
The retry is a second attempt of the existing renew authority, bounded to one pending timer, cleared on a successful tick and on stop. The new logs are signal only.

## 4b. Judgment-point check (Judgment Within Floors standard)
No LLM judgment involved; all deterministic.

## 5. Interactions
- Renew retry calls the same `leaseRenewTick()`, guarded by `leaseRenewing` and `holdsLease()`, so it cannot run concurrently with a regular tick or renew a lapsed lease. Cleared in `stop()`.
- Resilient-renew and origin renewal owners are untouched.
- Wakeup: `config.authToken` already exists; no new secret path.

## 6. External surfaces
One extra lease broadcast at most per unconfirmed interval. Two new console log lines. No route, config or schema change.

## 6b. Operator-surface quality (Operator-Surface Quality standard)
The wakeup message now names why it fell back to the registry, in plain words.

## 7. Multi-machine posture (Cross-Machine Coherence)
This is a multi-machine fix: a holder no longer loses the lease to timer drift after one unconfirmed renewal, which caused the lease to flap to the standby. Single-machine agents never construct the renew loop, so they are unaffected.

## 8. Rollback cost
Revert the commit. No persisted state is introduced; a completed revocation stays completed, which is the intended state.

## Conclusion
Low risk, narrow, tested: `tests/unit/lease-renew-unconfirmed-retry.test.ts`, `tests/unit/wakeup-targets-awake-machine.test.ts`, `tests/unit/machine-identity.test.ts`. Reviewed by Echo on PR #2159 with nothing blocking; his one suggestion (log a rejected token) is included.

## Evidence pointers
- Spec: docs/specs/lease-unconfirmed-candidate-flap.md
- Issue: instar#2122
- Review: PR #2159 comment by Echo at head d33fd175
