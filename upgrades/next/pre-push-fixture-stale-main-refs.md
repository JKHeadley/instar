# Pre-push fixture guard: stale main refs

<!-- bump: patch -->

## What Changed

The pre-push fixture guard checks commits against every available local main ref. A stale `upstream/main` can no longer cause a clean branch to be refused when the same commit is already on `origin/main`. Its recovery message recommends fetching main refs before changing branch history.

## What to Tell Your User

A clean push is no longer blocked just because one workstation's copy of main is out of date. The guard still rejects test-fixture commits that are new on the branch.

## Summary of New Capabilities

The guard handles stale or diverged `upstream/main` and `origin/main` refs while preserving detection of branch-only fixture commits.

## Evidence

The isolated regression failed before the change and passes after it. All ten focused guard tests pass, including stale, diverged, tracked-upstream, and branch-only fixture cases. TypeScript and script syntax checks pass.
