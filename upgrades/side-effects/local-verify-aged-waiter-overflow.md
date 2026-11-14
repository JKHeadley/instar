# Side-Effects Review — Long-waiting Local Verify PRs share the throughput overflow

**Version / slug:** `local-verify-aged-waiter-overflow`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, a narrow fairness fix in `src/localVerify/LocalVerifyService.ts`. When the queue holds `queueCap` (10) PR entries, an ordinary PR is refused and goes on the waiting list; only a `merge-throughput` labelled PR may use the `throughputOverflow` (5) places. With labelled PRs arriving faster than the verifier drains them (2026-11-13: 10 labelled PRs opened over ~10 h, queue held at 11), the waiting list never moved: PR 3108, first refused 2026-11-12 22:30 UTC, was still 5th of 27 waiters 18 h later. The queue already had an aging bound (`effectivePriority`: an ordinary entry that waited `THROUGHPUT_AGING_MS` ranks with the label); the waiting list had none.

Now (1) `request()` admits an ordinary PR whose waiter `firstRefusedAt` is at least `THROUGHPUT_AGING_MS` (90 min) old under `capFor(mergeThroughput)`, audited as `queue-full-throughput-admitted` with `agedWaiter: true`. Only a LIVE waiter counts, and only when no older live aged waiter is ahead of it, so aged waiters take the overflow oldest first and a stale one (no longer offered) never jumps the line; (2) `effectivePriority` counts aging from `min(firstRefusedAt, firstQueuedAt)`, so an admitted waiter is not made to wait the window again inside the queue.

## Decision-point inventory

- `LocalVerifyService.request` queue-full branch — modify — one more way into the existing bounded overflow.
- `effectivePriority` — modify — aging start time.

---

## 1. Over-block

None added. Fewer refusals: aged waiters now get in while overflow places are free.

---

## 2. Under-block

The overflow bound is unchanged (15 PR entries). Labelled PRs and aged waiters now compete for those 5 places on whichever is offered first; a labelled PR no longer has them to itself. That is the point: the label was meant to put throughput work first, not to keep ordinary work out indefinitely.

---

## 3. Level-of-abstraction fit

Same layer and same constant as the existing in-queue aging rule; the waiting list gets the bound the queue already had.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this changes queue admission order, not a block/allow decision on a PR's merge. Verification itself is unchanged.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point added; the 90-minute window reuses `THROUGHPUT_AGING_MS`.

---

## 5. Interactions

- **Replays, repairs, keptPlace re-queues, rerunAfterGreen:** excluded or unchanged (`agedWaiter` requires `!replayPriority && !repair`; keptPlace skips the branch).
- **pausedMs:** still subtracted only for in-queue pauses; time on the waiting list (including main-red, update pauses and downtime) counts in full. This can only overcount, so a PR reaches the overflow sooner, never later.
- **Peer dispatch ordering:** uses the same `effectivePriority`, so an admitted aged waiter ranks at the throughput level there too.
- **Persistence:** queue entries already persist `firstRefusedAt`; no format change.

---

## 6. External surfaces

Only the agent holding the Local Verify lease (the instar maintainer's) runs this. No persistent-state format change, no operator surface.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**: the queue and waiting list are single-writer on the lease holder.

---

## 8. Rollback cost

Pure code change: revert and release. No state or migration.

---

## Conclusion

Closes the starvation gap the existing aging rule left on the waiting list, inside the existing overflow bound. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude)
**Independent read of the artifact: concur, with notes**

Concurred: the 15-entry bound holds (aged waiters pass the same `capFor(mergeThroughput)` check); replays, repairs, keptPlace and rerunAfterGreen are excluded or untouched; `firstRefusedAt` persists on queue entries and both the local pump and peer dispatch sort with `effectivePriority`. Notes: (1) aged waiters were admitted in offer order, not wait order; (2) a stale waiter counted as aged; (3) wait outside the queue is not reduced for pauses (benign overcount); (4) admitted waiters enter behind earlier labelled entries (fine). Notes 1 and 2 are fixed in this PR (`waiterAged` requires a live waiter with no older live aged waiter ahead), with a test that fails without the ordering check; note 3 is documented in the code comment.

---

## Evidence pointers

- Live `/local-verify` on the lease holder, 2026-11-13 ~17:13 UTC: 11 queued (10 `merge-throughput`), 27 waiting; PR 3108 first refused 2026-11-12 22:30 UTC, 41 refusals.
