# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`GET /updates/status` now includes the `restartImmediately` field. PR #641 added
the primary-developer-mode flag and claimed it was surfaced in this endpoint, but
the route's hand-picked response object had omitted it — so the flag's live state
wasn't actually readable there. This adds the one missing line so the route
echoes the value `AutoUpdater.getStatus()` already computes.

## What to Tell Your User

Nothing to do. If anyone asks how to tell whether an agent is set to always jump
to the newest version immediately, the status readout now shows that on/off state
directly.

## Summary of New Capabilities

- `GET /updates/status` response gains a `restartImmediately` boolean (default
  false for the fleet; true for an agent in primary-developer mode). Read-only;
  agents gain it automatically on update.

## Evidence

- The gap was observed live on 1.3.180: with the flag set true in config, the
  agent behaved correctly (restarts not deferred) but `/updates/status` returned
  no `restartImmediately` field — the #641 "surfaced in /updates/status" claim
  was incomplete.
- Test: `tests/integration/updates-status-restart-immediately-route.test.ts`
  (+2) — asserts the field is present and correct for both true and false. tsc +
  linters clean.
