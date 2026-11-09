# Side-Effects Review — takeover on a pair with no shared lease medium

**Version / slug:** `lease-takeover-no-shared-medium`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** independent general-purpose subagent (Opus 5.5) and codex-cli gpt-6-astra, 3 rounds; design changed on their findings; last round minor issues, fixed

## Summary of the change

Behind the existing dark switch `multiMachine.leaseSelfHeal.soloCaptainHold`: `GitLeaseStore` treats a local write as final when there is no remote; a holder with a peer and no named preferred machine keeps its epoch when it cannot confirm; a machine pulls from peers, with a 10-second deadline, before taking back its own lapsed lease. Files: `src/core/GitLeaseStore.ts`, `src/core/LeaseCoordinator.ts`, `src/commands/server.ts`.

## Decision-point inventory

- `soloCaptainHoldEligible` — modify — pools with a peer and no named machine skip the preferred and peers-gone tests.
- `GitLeaseStore.casWrite` — modify — a failed push with no remote and the exact candidate on disk is a success.
- `acquireIfEligible` — modify — one bounded read before re-acquiring an own lapsed lease.
- takeover readiness line — modify — no longer reads failing when the fix is on.

---

## 1. Over-block

None added. The pull delays an own re-acquire by at most 10 seconds, only with the switch on.

## 2. Under-block

Two machines can believe they hold during a cut, by design; see the spec. With internet on both sides, pollers fight and jobs run twice until reconnect. An agent with no renew timer can still climb epochs.

## 3. Level-of-abstraction fit

Right layer: the coordinator owns hold decisions and the store owns what a write means. `GitSync.commitAndPush` is deliberately unchanged, because `sync()` reports it as pushed.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. These are lease rules inside the existing fence, with config facts and signed epochs as inputs. No brittle check gains authority over messages.

## 5. Interactions

`pollFollowsLease` follows the lease and is unchanged. The contested resolver now works on git through `forceLocalExpiry`. The expired record keeps its old signature, so it fails verification and is only a local floor; the integration test runs that path. `nextNonce` falls back to the wall clock there.

## 6. External surfaces

None while the switch is off. The readiness line changes only when it is on.

## 7. Multi-machine posture

The lease is the coordination layer. Store behaviour is machine-local; mixed local and git pairs are tested. Older peers accept a higher signed epoch as before.

## 8. Rollback cost

`soloCaptainHold.enabled: false`, read live. No data changes shape.
