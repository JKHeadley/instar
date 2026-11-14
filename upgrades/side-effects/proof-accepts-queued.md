# Side effects: proof-accepts-queued

**Change.** In the rebalance proof, `queued` from the lease holder counts as reached, so the proof goes on to wait for the reply.

**Reach.** The proof only, on listed test topics. No live path changes.

**Failure.** No reply within the existing timeout is still red, as `no-reply`. `queued` with no holder route stays red as `probe-queued`, the case that first motivated that reason.

**Rollback.** Revert the commit.

**Known limit.** This stops the proof misreading the delay; it does not fix the delay. A new owner learns of a move by pulling replicated placements, measured at 33 s to over 3 minutes, and a message sent in that gap waits in the queue. That is tracked separately.
