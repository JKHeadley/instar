## What Changed

PR #1155 fixed the misleading NOTICE for an age-limit recycle of an active
autonomous run ("recycled, no work lost, I'll pick it back up on my next turn").
This change closes the behavioral gap behind that notice: the run now actually
comes back on its own, instead of waiting for the next message.

A long autonomous run periodically hits its per-session lifetime cap and gets
recycled. That age-limit reap fires precisely when the session is IDLE between
turns — so the Mid-Work Resume Queue saw no in-flight work evidence and never
queued the run for revival. If the operator was away, the run sat dead until they
sent a message. Now, when an age-limit reap targets a topic that still has an
ACTIVE autonomous run, the live run itself counts as the work evidence: the reap
is admitted to the resume queue and revived through the SAME one-at-a-time,
quota-gated, resurrection-capped machinery as any other revival.

It stays safe by construction: a double-spawn is caught by the existing
live-session / resume-uuid drain-time checks (a message-revive that beat the queue
wins, ZERO second spawn); a run that keeps getting reaped-and-revived hits the
resurrection cap and gives up loudly with one aggregated notice; a run that has
since finished (or whose window elapsed) is invalidated at drain time, never
re-spawned. The resume queue runs LIVE on a development agent and stays
observe-only on the fleet.

## What to Tell Your User

If you kick off a long autonomous run and walk away: when the session hits its
per-session lifetime cap and gets recycled, the run now revives itself
automatically instead of sitting idle until you next message it. You no longer
have to send a "you still there?" nudge to wake a recycled run back up. Nothing
double-runs, and a run that has genuinely finished is left alone.

## Summary of New Capabilities

- An age-limit recycle of a topic with an active autonomous run is now admitted to
  the Mid-Work Resume Queue and auto-revived (the live run is the evidence).
- A drain-time liveness re-check invalidates an entry whose run finished or whose
  window elapsed between enqueue and drain (never a wasted respawn).
- The resume queue resolves live-on-dev (dryRun:false) / observe-only-on-fleet,
  with an explicit operator override still winning.

## Evidence

- `tests/unit/resume-idle-autonomous.test.ts` — admission both sides, guard
  short-circuit (non-age-limit / null-topic / fail-open), dryRun-gate resolution
  (dev/fleet/explicit), drain-time re-check both sides + back-compat + throwing-dep.
- `tests/integration/resume-idle-autonomous-wiring.test.ts` — real-helper
  delegation, double-spawn lens (live-session + uuid-stale), lease lens,
  revival-loop lens (resurrection cap fires exactly once).
- `tests/e2e/resume-idle-autonomous-lifecycle.test.ts` — feature alive on dev
  (dryRun:false), enters-and-revives-once + no double spawn, fleet observe-only.
- `npx tsc --noEmit` clean; lint clean; docs-coverage check passed.
