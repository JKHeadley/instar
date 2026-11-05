# Side effects: proof-holder-target

**Change.** `sendProbe` in the rebalance proof now delivers a probe the router left to this machine, through new helper `deliverProbeLocally`.

**Also.** `rowIsFromMachine` attributes a proof reply by its origin record, and the proof's history read now asks for `includeOrigin=1`. Matching is on the display name, so a rename mid-run reads as the wrong machine, which fails red, the safe direction.

**Reach.** Only `POST /session-pool/rebalance-proof` runs on a listed proof topic. No live message path changes; the router and its empty `handleLocally` are untouched.

**Failure.** A failed delivery returns `undelivered`, so the proof goes red as `probe-undelivered` and logs why. Before, it was a silent drop read as `no-reply`.

**Rollback.** Revert the commit. The proof goes back to reading no-reply on a holder target.

**Second pass.** A session can be spawned by the probe on the holder; that is what a proof topic is for, and the existing spawn path applies its own limits.
