# Side-Effects Review — a git lease store with no remote reports no shared medium

**Version / slug:** `git-lease-no-remote-asks-first`
**Date:** `2026-11-08`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent, two passes (see below)`

## Summary of the change

Tier 1. 27 lines in `src/core/GitLeaseStore.ts` and 1 in `src/commands/server.ts`, plus tests. A revert fully undoes it. This is the fb-c51067c6-148 follow-up found by the #2912 live check.

`GitLeaseStore.hasNoSharedMedium()` now returns true when the repository has no git remote. It is read through a new `hasNoRemote` dependency, wired to the existing `gitLeaseHasNoRemote(projectDir)`, and cached for 60 s. An unreadable check returns false. That makes the #2912 rules apply to a git home with no remote:
- asking peers before claiming,
- folding a live same-epoch peer lease over an expired own copy,
- renewal defaulting on,
- confirming the lease on a peer pull.

On the live pair, proof-2 (git, no remote) claimed epoch 817 without asking while nimbus (LocalLeaseStore) held 817 live. nimbus lost the same-epoch tie and made a role restart.

Effort: two review rounds. The first cut instead rolled back a failed `casWrite` candidate. The second-pass review showed four things wrong with that:
- It is deferred item (i) of `lease-unconfirmed-candidate-flap.md` (CMT-1226). <!-- tracked: CMT-1226 -->
- It could leave a git+git pair with no remote with no holder.
- With a remote, a push that reports failure but lands could see a rolled-back lease pushed later, which would lower the epoch.
- It silenced the unconfirmed-write alert.

It was dropped. This version leaves `casWrite` untouched.

## Decision-point inventory

- `LeaseStore.hasNoSharedMedium` for `GitLeaseStore`: modify. It is true only with no remote. Every consumer is the #2912 code, which already runs for `LocalLeaseStore`.

## 1. Over-block

A restarted git machine with no remote may wait up to the 10 s ask before claiming when its peer does not answer. This is the same bounded wait #2912 added for `LocalLeaseStore`.

## 2. Under-block

- When nobody answers, a git machine with no remote still claims. Its push fails, and it reads its own candidate back as held (the deferred item (i), CMT-1226). <!-- tracked: CMT-1226 --> With the peer down there is no tie. If the peer is up but slow past the ask, one tie per miss remains, as with #2912.
- It still cannot take over through git without `soloCaptainHold`. This is unchanged and disclosed in fb-9eb4d9d0-6f0. <!-- tracked: fb-9eb4d9d0-6f0 -->
- A remote added or removed takes up to a minute to be seen.

## 3. Level-of-abstraction fit

Right layer. The store reports what it is, and the coordinator decides. This is the same seam #2912 created.

## 4. Signal vs authority compliance

Complies. The flag is a fact about the medium. The signed lease and CAS stay the authority.

## 4b. Judgment-point check

None. It is a fixed fact, cached.

## 5. Interactions

- The #2912 rules run for this store now. They were proven on `LocalLeaseStore`, whose semantics a no-remote git home shares: only the wire carries the lease to peers.
- `localCommitIsFinal` and `forceLocalExpiry` are unchanged and still need `soloCaptainHold`.
- Renewal defaulting on, for a no-remote git holder. The server always wires the lease wire, so `renew()` broadcasts and never calls `GitLeaseStore.refresh()`. Such a machine holds only through the takeover switch or the unconfirmed read-back (CMT-1226). <!-- tracked: CMT-1226 --> Before, it had no renew timer and that hold ended within a lease length. Now a read-back hold lasts while the peer confirms the broadcasts, as with `LocalLeaseStore`. With the peer gone the broadcast is unconfirmed and it self-suspends as before, so nothing is taken over through git without the switch.
- A pair of git machines with no remote now behaves like a `LocalLeaseStore` pair: each asks before claiming and renews over the wire. This is no worse than today's flapping.
- The unconfirmed-write alert counts acquisitions, and `casWrite` is unchanged, so it is unaffected.
- A single machine with no peers and no remote also gets the renew timer. The broadcast is a no-op there, so this is harmless.
- The `lease-http-convergence` flap harness: every row is unchanged (its git worlds have a remote).
- Cost: one `git remote` call per minute at most, instead of none.

## 6. External surfaces

None, beyond fewer restarts on such pairs.

## 7. Multi-machine posture

Multi-machine by nature. Mixed versions are safe, and an updated git-no-remote machine stops creating ties from its side.

## 8. Rollback cost

Revert the commit. No state, migration or config.

## Conclusion

This closes the tie source the live check found, using #2912's proven rules, with no change to write semantics. The live pair gets it on the next update, and the check repeats there.

## Second-pass review

**Reviewer:** independent general-purpose reviewer subagent, 2026-11-08

- Pass 1, concern raised, against the first cut (rolling back a failed `casWrite` candidate). That cut was item (i) of CMT-1226. <!-- tracked: CMT-1226 --> It could leave a git+git no-remote pair with no holder, and with a remote a reported-failed push that landed could later lower the epoch. It also silenced the unconfirmed-write alert, and its tests proved less than they claimed. The cut was dropped.
- Pass 2, concur, on this version. No harm found in turning on the four rules. The fold works with the read-back: `selfIssued` wins at its own epoch, and after a restart the expired stored copy loses to a live peer lease. One disclosure was corrected above: renewal goes over the wire, so a read-back hold now persists while the peer confirms.

## Evidence pointers

- Live, 2026-11-08 11:00-11:28Z on nimbus and proof-2, both on 1.3.1719-local.70b91b2a. proof-2 logged `CAS lost to epoch 817 ... yielding` and `Lease reconcile → awake (lease-init)`. nimbus logged `contested tie-break: YIELDED ... at epoch 817` and a role restart.
- `tests/unit/lease-restart-no-tie.test.ts`: a git home with no remote asks, and a live lease stops the claim (at a higher epoch and at its own lapsed epoch); nobody answering still tries; with a remote it does not ask; unknown or absent means false; the cache runs once a minute and sees a change. With the flag forced off, 5 fail.
- On the M5, the lease files at each tier: unit 127/127, integration 24/24 (flap harness included), e2e 9/9.
