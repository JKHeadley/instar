<!-- bump: minor -->
<!-- change_type: feature -->

## What Changed

A new guard in the agent's Stop hook catches a specific, recurring self-sabotage: the agent names
clear work it knows how to do next, then stops anyway with a self-protective excuse — "this session
is too long," "it's late," "I made mistakes so I'll be careful," "I don't want to rush," "it's
tracked so it won't slip," "I'll do it next session." Those are false reasons to stop. The guard
detects the pattern (a named next action plus one of those rationalizations) and blocks the stop
once, re-feeding a reminder that the excuse is false and to proceed now. It can never trap the agent
in a loop, and it leaves a genuine stop alone (a real external blocker, work actually finished, or a
decision only the user can make).

## What to Tell Your User

Your agent should stop wasting your time by quitting partway through work it clearly knows how to
finish. If it tries to stop with an excuse like "it's late" or "let's do this next session" while
there's an obvious next step, it now gets caught and nudged to just do the thing — so you no longer
have to come back and say "okay, do the thing you just said you'd do."

## Summary of New Capabilities

- `stop-gate-router` hook gains a mode-independent `falseExcuseDeferralGuard`: when the final message
  contains BOTH a named piece of remaining work AND a self-protective deferral rationalization
  (session-length, time-of-day, made-mistakes, don't-rush, tracked-so-it-won't-slip, next-session),
  it blocks the stop once and re-feeds a "this is false — proceed now" directive.
- Pure substring matching, fires once per stop (the `stop_hook_active` loop guard prevents traps),
  and requires the AND of both signals so a genuine completion or a no-work time reference is not
  blocked.
- Ships to every agent automatically via the always-overwrite hook update path (no per-agent
  migration needed).

## Evidence

**Before:** the Stop gate only caught "stated-continuation" (the agent saying "I'll do X now" then
not). It did NOT catch the inverse — the agent explicitly justifying NOT doing the clear next thing
("after a long session I won't rush this; it's tracked"). That pattern repeatedly ended sessions
early and forced the operator to re-issue "do the thing you just said." **After:** the new guard
catches it. Reproduced by `tests/unit/stop-gate-false-excuse-deferral.test.ts` (6 cases): it renders
valid JS, blocks the real-world excuse-stop and a session-length/next-session deferral, does NOT
block a genuine completion or a time reference with no pending work, and does NOT re-block under
`stop_hook_active`. The existing `stop-gate-stated-continuation` + `generated-hooks-parse` suites
stay green.
