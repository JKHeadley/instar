# Side-Effects Review: keep peer verify results through a coordinator restart, and prefer a free peer when the coordinator is busy

**Version / slug:** `local-verify-peer-lease-carry`
**Date:** `2026-11-11`
**Author:** `echo`
**Second-pass reviewer:** `not run (worker session cannot spawn a reviewer; see Conclusion)`

## Summary of the change

Tier 1. 3 files, about 120 changed lines in source plus about 150 in tests. Effort: 0 spec rounds, 1 commit attempt. The design was redone once after the claim check showed that #3066 already held half of it.

This is CMT-1605, opened after the Mac Studio's live night of 2026-11-10/11. The coordinator dropped every peer attempt whose lease epoch changed (`peer-attempt-abandoned reason=lease-changed`, 12 times in 3 hours) and also cancelled the M5's run each time. Every restart of the Studio's server re-acquires the serving lease at the next epoch, so a restart threw away whatever the M5 was running. The audit log shows the pattern: `peer-attempt-abandoned lease-changed` arrives a few seconds before `lease-acquired foreignHolder=false` at the next epoch.

Stacked on PR #3066 (`echo/lv-fast-lane`), whose last commit already adopts a peer attempt when the reconciler reports a same-machine re-acquisition (`foreignHolder:false`). That is not enough in two ways:

1. `foreignHolder` is held in memory, so after a restart it always reads false, even when another machine held the lease meanwhile.
2. The wait-for-the-lease was limited to the first 10 minutes after boot. A lease that lapsed without a restart (`lease-lost` at 05:05:08 tonight) still abandoned the attempt and cancelled the M5's run.

Changes:

- `src/localVerify/peer.ts`: new pure `remoteLeaseDecision(current, sentAt, lease, ctx)`, returning keep / carry / wait / abandon.
- `src/localVerify/LocalVerifyService.ts`:
  - `onLeaseAcquired` adopts only at exactly the next epoch.
  - `pollPeers` uses the decision. It carries to exactly the next epoch (audited `peer-attempt-adopted via=poll`, persisted). It waits whenever the lease is not held and no other machine is named holder (audited once as `peer-attempt-lease-wait`), bounded by `PEER_LIMITS.maxRunMs` instead of a boot grace. It abandons on a foreign holder or an epoch gap.
  - The boot-grace constant and field from #3066 are removed.
  - New `deferLocalStartToPeer()` in `pump()`: when this machine's own heavy-work fit reads `machine-busy`, a queued PR verify is left for a healthy, free peer. This is the same `heavyFit` the pool uses for peers. The deferral is bounded per entry by `STRAINED_PEER_PREFERENCE_MS` (10 minutes, after which the entry runs locally), and a `main` verify is never deferred.
- `tests/unit/localVerify/peerVerifier.test.ts`:
  - New tests for the decision table, an epoch gap, a carry by the poll, a double carry, a lapse without a restart, the wait bound, and the strained preference.
  - #3066's restart test now re-acquires at epoch 8, the next epoch, instead of 10.
  - Two older tests now use an epoch jump (7 → 9).

## Decision-point inventory

- Coordinator lease fence on a peer reservation (`pollPeers`): **modify**. A contiguous own epoch now carries the reservation instead of abandoning it, and a not-held lease with no foreign holder now waits.
- Peer record import fence (`importRefusal`): **pass-through**. #3066's adopted-epoch mapping is unchanged.
- Local start vs peer dispatch order (`pump`): **modify**. A strained coordinator prefers a free peer, within a bounded window.

---

## 1. Over-block

- The strained preference holds a PR back for at most 10 minutes. It applies only when a peer is free (not reserved, breaker closed, and status idle and version-matched, or not yet read).
- A peer that reads idle but then refuses keeps the deferral alive only until the window ends, after which the PR runs locally.
- `main` is never held back.

## 2. Under-block

- If this machine's own lease renewals advance the epoch by two or more between two polls (for example, the server's event loop stalls for longer than two lease cycles), the gap is indistinguishable from another machine holding the lease. The attempt is abandoned as it is today. This is the conservative direction.
- An epoch advance seen while another machine held the lease at the same epoch would be a split-brain lease, which predates this change and is out of its reach.

## 3. Level-of-abstraction fit

The fence stays where it was: in the coordinator, using the lease the coordinator already reads. The continuity proof uses the lease's own invariant. Epochs only grow, and each successful acquisition takes epoch+1 by compare-and-swap (`LeaseCoordinator`), so holding E and then E+1 means no other machine held the lease in between. The strain signal reuses `heavyFit` from `machineResourceProfile.ts` through the existing `peerFit` seam. No new detector was added.

## 4. Signal vs authority compliance

No new blocking authority. The carry decision narrows an existing refusal using a structural invariant, not a heuristic. The strained preference is a bounded ordering preference that consumes the pool's existing load signal. It never refuses a verify; it only changes which machine runs it, and the bound guarantees local execution.

## 4b. Judgment-point check

The strained preference is a static rule at a resource decision. It is not a competing-signals judgment: one existing fit verdict (`machine-busy`) gates a bounded reordering with a guaranteed fallback.

## 5. Interactions

- Peer side unchanged: a peer still self-cancels when it becomes the lease holder, so a takeover during the coordinator's restart still ends the peer run. The coordinator then sees a foreign holder or an epoch jump and abandons.
- The restart heartbeat (`qualifyingPeerAttempts`, via #3066's `remoteEpoch`) follows the carried epoch, so a planned restart keeps waiting on a carried attempt as before.
- `dispatchOnce` is unchanged. The deferral calls `scheduleDispatch` so the free peer is asked on the same pump.

## 6. External surfaces

- New audit rows: `peer-attempt-lease-carried`, `peer-attempt-lease-wait`, `local-start-deferred-to-peer`, `local-start-deferral-expired`.
- No new persisted field: this uses #3066's `remote.adoptedEpoch`.
- No wire or protocol change between coordinator and peer.

## 6b. Operator-surface quality

Not applicable: no operator surface touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design. The coordinator's queue and reservations live on the lease holder. Peer records are imported only by the coordinator that dispatched them, which `wrong-coordinator` still enforces. The change makes the coordinator keep cross-machine work through its own restart; it adds no replicated state.

**Status surfaces:** none new. `GET /local-verify` snapshot output is unchanged in shape.

## 8. Rollback cost

Revert the PR. With this PR reverted, #3066's behaviour returns. No data migration.

## Conclusion

Ship. The second-pass review applies because the change touches a dispatch-ordering decision. This worker session cannot spawn a reviewer, so an independent read is requested on the PR. The Local Verify harness review covers it before merge.

## Evidence pointers

- Live audit (`.instar/logs/local-verify.jsonl`, 2026-11-11 04:00Z to 08:30Z):
  - 12× `peer-attempt-abandoned reason=lease-changed`, 16 dispatches, 0 imports from the M5 in that window.
  - Epochs 23480 → 23481 → 23482 → 23483 were all re-acquired by the Studio itself (`foreignHolder:false`).
- Unit tests: `tests/unit/localVerify/peerVerifier.test.ts`.
- Trade-off stated: an epoch gap on the same machine (for example, the event loop stalls through two lease cycles) now abandons where #3066 would adopt. That is the conservative direction, and tonight's re-acquisitions were mostly contiguous (23480 → 23481 → 23482 → 23483).

## Second-pass review (if required)

**Reviewer:** independent reviewer (coordinator-dispatched), PR #3073
**Independent read of the artifact: concern** — no stale or forged import path found. Five findings, all fixed in the follow-up commit:

1. **MEDIUM, fixed.** The strained deferral could hold the whole local queue, including a queued `main` canary, for 10 minutes. A stale "free" peer reading also let each PR spend its own window in turn. Now:
   - No deferral while any `main` entry is queued.
   - The suite-slot claim is released while deferring.
   - Only one deferral is active at a time.
   - An expired deferral starts a cooldown of one more window, during which nothing is deferred.
2. **LOW-MED, fixed.** An epoch bump during the result fetch made `importRefusal` return `lease-epoch-changed`, which counted against the peer's breaker. Now the lease decision is re-run after the fetch: exactly +1 is carried, a lapse waits, and anything else abandons with `failure:false`. Lease-fence refusals (`lease-epoch-changed`, `not-lease-holder`) never count against the peer.
3. **Fixed.** `onLeaseAcquired({foreignHolder:true})` now explicitly abandons every reservation, even at the next epoch. Previously the poll alone would have carried a +1 move.
4. **LOW, fixed.** The lease-wait audit set is cleared on keep, carry and import.
5. **NIT, fixed.** The per-entry spent-marker map is gone; a single deferral slot plus a cooldown replaces it.

Tests added for each of these. All five failed on the previous commit and pass now.
