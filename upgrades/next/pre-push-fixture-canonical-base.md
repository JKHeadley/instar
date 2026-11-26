# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The pre-push fixture guard compares the feature branch with remote main when that ref is available. Commits already on main are outside the scan. The guard still checks feature commits for fixture author identities and commit messages.

## What to Tell Your User

Merging main into a feature branch no longer makes the push guard flag an old fixture-like commit already on main.

## Summary of New Capabilities

The push guard catches newly introduced fixture commits after a feature branch merges main.

## Evidence

The regression fails with the old guard and passes with the fix. All seven focused checks passed.
