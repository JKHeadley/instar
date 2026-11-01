# Merge conflicts no longer trip the peer verifier breaker

<!-- bump: patch -->

## What Changed

When a peer reports that a PR head conflicts with its dispatched base, the coordinator spends that PR's bounded peer attempt without counting it as a peer health failure. Other peer errors still count toward the existing three-failure, 30-minute breaker.

## What to Tell Your User

A PR merge conflict no longer sidelines a healthy test machine. The conflicted PR stays blocked until its branch is fixed; other PRs can keep using that machine.

## Summary of New Capabilities

The existing peer breaker now distinguishes a PR input conflict from a peer execution failure.

## Evidence

On 2026-11-01, PR #2516 returned `errorStep: conflict` twice from M5 and incorrectly increased its `consecutiveFailures` to two. A third unrelated conflict would have opened the breaker for 30 minutes. Unit coverage exercises both conflict and install-error records through the coordinator's peer-result path; authenticated HTTP integration and production lifecycle tests cover the existing peer wiring.
