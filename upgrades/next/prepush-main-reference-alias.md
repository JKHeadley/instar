# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The pre-push checks use the newer, proven descendant when local aliases share a remote URL. Release fragments brought in by merging main stay out of the branch's diff.

## Evidence

An isolated Git fixture with two aliases reproduced the merge-from-main case. The gate accepted the inherited fragment and still refused an internal-only fragment introduced by the runtime branch, even when a local branch shared the name of the remote-tracking branch. All 23 focused tests passed.
