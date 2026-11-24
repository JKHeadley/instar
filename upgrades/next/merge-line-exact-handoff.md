# Upgrade Guide — vNEXT
<!-- bump: patch -->
## What Changed
The verification merge line reads the exact green pull request directly instead of requiring it to appear among the oldest hundred authored discovery entries. It preserves current author, repository, commit, hold, full-verification and safe-merge checks.
## What to Tell Your User
A finished change can reach the merge checks even when a long queue puts it outside the routine scan. This does not let a change skip testing or approval requirements.
## Summary of New Capabilities
No new user action or setting. This repairs the existing handoff from complete verification to merge checks.
## Evidence
An unchanged-runtime regression reproduced the exact not-listed refusal while forty existing unit checks passed. Actual enforcing focused verification passed107unit, one HTTP and one production-construction/start lifecycle check, zero failures/skips, all exitszero. Build and TypeScript passed. Complete exact-head verification remains required after publication; no live result is claimed here.
