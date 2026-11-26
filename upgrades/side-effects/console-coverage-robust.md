# Side-Effects Review — truthful replica freshness, coverage policy, resilient console reads

**Version / slug:** `console-coverage-robust`
**Date:** `2026-10-31`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

- `src/core/CommitmentsSync.ts`: adds `CommitmentReplicaStore.confirmCurrent()` and an in-memory `confirmedAt`. `allReplicas()` reports the later of `receivedAt` and `confirmedAt`.
- `src/commands/server.ts`: `driveCommitmentsSync` calls `confirmCurrent()` when the peer's advert shows the replica is caught up.
- `dashboard/console/home-model.js`: only a blind mesh read makes the promises card partial.
- `dashboard/console/console.js`: `get()` has a 20 s floor and one automatic retry for timeouts, network errors and 5xx other than 503.

Tier 1, about 70 source LOC.

## Decision-point inventory

- Replica staleness (signal) — modify — measured from the last confirmation as well as the last applied page.
- Home "partial" decision (presentation) — modify.
- Console read failure (presentation) — modify — one retry before "can't tell".

## 1. Over-block

No block surface.

## 2. Under-block

A peer whose advert is fresh while its served data would be wrong is outside this change: the advert's seq has always been the source of truth for "nothing new". A machine that has genuinely stopped answering stops sending adverts, so it is never confirmed and still ages. Home no longer headlines a single behind machine. That machine is named in the promises note and stays visible under "See agent status".

## 3. Level-of-abstraction fit

Freshness belongs to the receive side that knows the advert. The retry sits in the single console read path that every page uses.

## 4. Signal vs authority compliance

Signals only. Nothing blocks or gates.

## 5. Interactions

`confirmCurrent` writes nothing to disk, so presence ticks add no I/O. After a restart, the first presence pass confirms again. Retries double the worst-case wait for a page that genuinely fails (up to about 40 s), and each read still has its own timeout.

## 6. External surfaces

`/commitments?scope=mesh` `stalenessMs` for idle peers is now small, which is the truthful value. Console wording on a final failure gains ", twice".

## 6b. Operator-surface quality

This removes a near-permanent vague warning. A real gap is named instead (machine and age), in the fold rather than the headline.

## 7. Multi-machine posture

Each machine confirms its own replicas of each peer, so the fix applies on every machine.

## 8. Rollback cost

Revert the PR. No persisted state changes.
