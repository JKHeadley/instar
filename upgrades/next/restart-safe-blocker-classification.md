# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`GET /updates/status` now classifies the sessions that are currently blocking a
deferred restart into two read-only buckets: `restartSafeSessions` (topics that
resume cleanly across a restart — resumable autonomous topics with a per-topic
state file) and `hardBlockingSessions` (everything else). This is
observability-only: the restart **decision is unchanged** — a restart-safe
blocker still defers exactly as before, even when every blocker is restart-safe.

This is Step 1 of "restart-safe sessions," an idea the codex agent scoped during
a mentorship session: the goal is eventually to let the updater restart through
sessions that resume cleanly (so an installed update can't sit behind a
long-running session), but that acting-on-it step is deliberately deferred. This
PR only establishes the classification.

## What to Tell Your User

Nothing to do. If anyone asks which busy sessions are holding back a pending
restart, the status readout now shows which ones could be safely restarted
through versus which are genuine hard blockers. The agent still restarts on the
same schedule as before.

## Summary of New Capabilities

- `GET /updates/status` gains two read-only arrays: `restartSafeSessions` and
  `hardBlockingSessions`. Both empty when not deferring. Agents gain them
  automatically on update.
- `UpdateGate` gains an optional `restartSafetyResolver` predicate (off by
  default → identical to prior behavior). `AutoUpdater` wires it to the
  per-topic autonomous-state-file check.

## Evidence

- New unit tests (`tests/unit/UpdateGate.test.ts`, +5) prove mixed blockers
  still defer while splitting correctly, all-restart-safe still defers (the
  no-behavior-change invariant), no-resolver back-compat, fail-safe on a
  throwing resolver, and reset clearing.
- New integration tests (`tests/integration/updates-status-restart-safe-sessions-route.test.ts`,
  +2) assert the route surfaces both fields. tsc + linters clean.
