# Restore preferred-machine lease deferral during regular ticks

The recurring standby tick now uses the same healthy-holder predicate that already guards boot acquisition. A verified live, unreleased lease for the configured preferred machine defers this standby's call into acquisition. Once that evidence expires or is replaced, normal acquisition resumes. The holder's renewal and the existing rules for resolving an actual same-epoch contest stay available.

The guard uses the coordinator's existing effective lease view. A stale local view can still make a standby wait until the verified lease expires. A partition can still leave the standby without a live view, in which case the existing acquisition fences decide. Rollback reverts the one branch condition. This requires no stored-state migration.

## Second-pass review

**Reviewer:** Independent lease authority reviewer.
**Result:** Concur. The recurring guard reuses verified live-lease evidence and preserves the existing tie-break when the peers disagree. The regression uses a signed preferred-captain lease at epoch 23813 and checks that acquisition becomes eligible again once it expires.

The preference follows the signed lease expiry, including a valid planned-restart extension. It takes precedence on this tick over optional early takeover based on stale renewal observations. An expired or released lease allows the standby to evaluate acquisition again.
