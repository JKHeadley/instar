# The dashboard stops saying "part of the list could not be checked" for no reason

<!-- bump: patch -->

## What Changed

The operator saw "Nothing needs you that I can see. Part of the list could not be checked." almost every time. There were three causes, and all three are fixed.

- **A quiet machine looked stale.** The commitments replica's age was measured from the last page *applied*. When a peer's advert showed nothing new, no page was pulled, so an idle but current peer aged by the minute: the Mama PC read as 2 h 16 min "out of date" while the Studio confirmed it every presence tick. `CommitmentReplicaStore.confirmCurrent()` now records the advert's confirmation (in memory), and staleness is measured from the later of the two. The `driveCommitmentsSync` up-to-date path calls it.
- **"No promises from a machine" was read as "couldn't check it".** The M5 Pro has no promises, so every Home view counted it as missing. One machine that is behind, or one with no promises, is now named in the promises note under "See agent status". Only a blind read (no other machine's promises at all while other machines exist) still marks the operator's list partial.
- **Reads gave up too soon.** Every console page reads through one `get()`. No read now gives up in under 20 seconds, so pages that asked for 8 s are raised. A timeout, a dropped connection or a 5xx (except 503) is retried once on its own before any page says "can't tell". The Sessions page had been failing at 8 s.

## What to Tell Your User

The dashboard should stop telling you parts of it couldn't be checked when nothing is actually wrong. It now waits longer and tries again on its own, and a quiet machine no longer looks out of date.

## Summary of New Capabilities

None. This is a reliability fix: idle replicas read as current, and every dashboard read retries once.

## Evidence

On 2026-10-31 at 15:50 the Studio's own reads were healthy: attention 4/4 peers answered, sessions in 2-3 s. Even so, Home showed "part of the list could not be checked" for two reasons. The Mama PC's replica rows were all exactly 136 min old: it had nothing new to pull, so it was never refreshed. And the M5 Pro had no rows at all. Unit tests cover the replica confirmation (refusals included), the coverage policy, the console retry absorbing three failures, and the sessions failure wording.
