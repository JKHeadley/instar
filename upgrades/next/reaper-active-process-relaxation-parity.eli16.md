# Reaper active-process relaxation parity — Plain-English Overview

> The one-line version: the part of the agent that decides an idle session is safe to clean up, and the part that actually does the cleanup, disagreed — so idle sessions never got cleaned up; this makes them agree.

## The problem in one breath

Your agent keeps a "reaper" that closes conversation sessions that have gone idle, to free up the computer. It correctly noticed which sessions were idle and tried to close them — but the safety check that does the actual closing refused every single time, because every session has some always-on helper programs attached to it (the MCP tool servers). So idle sessions piled up and bogged down the machine, even though the reaper was trying to clean them.

## What already exists

- **The reaper** — watches every session, and when one has been silent for hours with a still screen and no new activity, marks it "safe to close."
- **A safety guard** — before anything actually closes a session, this guard double-checks it isn't busy. One of its rules is "if the session has a running helper program, keep it."
- **A relaxation rule the reaper already had** — the reaper was already smart enough to say "this session has been silent 8 hours and its only helpers are its own idle tool servers — don't let those shield it forever." It applied that relaxation correctly.

## What this adds

The reaper made the right call but had no way to tell the safety guard about it — so the guard re-applied the un-relaxed "it has a helper program, keep it" rule and blocked the close. We observed this happen 1,532 times in a row on one machine: noticed-idle, tried-to-close, refused, repeat.

This change lets the reaper pass its decision through to the guard: "I already accounted for the always-on helpers on this one — go ahead." The guard then lifts only that one rule, and still enforces every other safety rule (recent user message, an open promise to the user, an active sub-task, and so on). It mirrors an existing mechanism the recovery system already uses to do the same kind of "I've checked, proceed" hand-off.

## The new pieces

- **A single "the reaper already cleared the helper-program rule" flag** — set only by the reaper, only on a close it already judged safe, and it lifts only that one rule. It is NOT a master override: everything else the guard checks still applies, and the default (no flag) keeps the old protective behavior exactly.

## The safeguards in plain terms

- The reaper only closes a session after it has been silent for 8 hours (or its helpers are provably using no CPU under load), AND its screen hasn't changed, AND its transcript hasn't grown, AND it stayed still through a final grace period. A session doing real work fails those checks and is kept.
- Closing a session never loses the conversation — it is saved to disk and comes right back the next time that topic is messaged.
- If this turns out wrong, it is a plain code revert with no data to clean up, and the behavior can also be turned off with existing settings.

## What you need to decide

Whether to ship this fix. It removes a stalemate that let idle sessions pile up and slow the machine, with no new risky behavior — the riskier direction (closing something busy) is guarded by checks that were already there, and anything closed resumes seamlessly.
