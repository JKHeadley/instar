# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**The stop gate now catches the "I'll do it now" silent stall — even in shadow
mode.** A recurring failure: an agent's final message tells the user it is about
to act this turn ("I'll build that now", "starting now", "Next phase: ship the
fix") and then the turn simply ends, leaving the user staring at silence after
being told work was continuing.

The existing `stop-gate-router.js` hook delegated the continue/stop decision to
the server-side Unjustified Stop Gate, which only blocks in `enforce` mode — but
the gate ships in `shadow` (telemetry-only) mode on most agents, so the exact
moment a stall happened, nothing intervened.

This adds a small, always-on guard at the top of the hook. When the final message
states an imminent this-turn action together with an imminence marker (now / right
now / this turn / next phase / on it), the hook blocks once and re-feeds the
agent: either actually do the work, or send the user one honest sentence that it
is stopping and why. The guard is mode-independent (works even when the gate is in
shadow mode or the server is unreachable) and fires at most once — the existing
loop guard prevents any continuation trap. "Report-back-later" intent (no
imminence marker) is not caught; that stays with the commitment tracker.

## Evidence

Reproduction (live, topic 13481, 2026-05-31): the agent posted "I'm going to
build that now ... then deploy and finish the round-trip proof" at 16:56 UTC,
then ended the turn and went silent for ~90 minutes without starting the work.
Operator response: "your session has stalled again ... this is incoherent."

Root cause observed: a direct probe of the running gate returned
GET /internal/stop-gate/hot-path -> {"mode":"shadow",...}. In shadow mode the
stop-gate-router records telemetry but never blocks, so the stall passed through
unchallenged — the safety net was off at the exact moment it was needed.

Before: rendering the prior hook and feeding it the exact stall message
("Next phase: build the reverse reply-relay, then ship the fix") exits 0 — the
agent is allowed to stop silently.

After: the same rendered hook fed the same message exits 2 and writes
{"decision":"block", reason:"STOP-GATE (stated-continuation): ..."}, regardless
of the server's shadow/enforce mode and even with no server reachable. A benign
completion ("Done — all tests passed ...") still exits 0, and stop_hook_active=true
exits 0 (loop guard intact). Confirmed by executing the rendered hook as a
subprocess against each payload (tests/unit/stop-gate-stated-continuation.test.ts,
5/5 green).

## What to Tell Your User

Nothing to configure. Your agent can no longer tell you "I'll do that now" and
then quietly stop without doing it — if it tries, it gets nudged once to either
actually do the work or tell you plainly that it is stopping and why. The result
is fewer confusing silences after an agent says it is continuing.

## Summary of New Capabilities

- Local, mode-independent stated-continuation guard in the stop-gate-router hook
  (`PostUpdateMigrator.getStopGateRouterHook()`); deploys to every agent on update
  via the always-overwrite built-in hook path.
