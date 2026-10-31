# Manual updates wait for active verification

<!-- bump: patch -->

## What Changed

A normal manual update now waits to restart while Local Verify is testing a PR or main. The update is installed, and the existing bounded restart hold releases when that run ends. An explicit `forceRestart:true` on `POST /updates/apply` bypasses the hold, including after installation has already deferred the restart.

## What to Tell Your User

Applying an Instar update no longer throws away an in-progress merge check by default. If a restart cannot wait for that check, the agent can explicitly bypass its hold; the normal session and restart-cooldown gates still apply, and an interrupted check will run again.

## Summary of New Capabilities

The existing update route reports its restart deferral and accepts an explicit forced-restart field. Fresh and existing agent instructions explain the behavior.

## Evidence

An observed manual update interrupted PR #2499 after 11.6 minutes. Unit, authenticated HTTP integration, production lifecycle, and full-suite tests cover the guarded and forced paths before release.
