# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Shipping watcher checks whether pull requests that previously exhausted merge retries have since closed or merged. GitHub-confirmed terminal pull requests are removed from the stuck count.

## What to Tell Your User

The stuck count clears old pull requests after GitHub confirms they have closed or merged.

## Summary of New Capabilities

The existing Shipping view refreshes the status of old entries automatically.

## Evidence

The watcher tests cover confirmed closed and merged results alongside open and unavailable results.
