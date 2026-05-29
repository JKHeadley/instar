# Cross-Session Coordination — plain-English overview

## What this is, in one line

When more than one copy of me is running at the same time on the same machine, this
gives them a way to *see each other* before they each do something big — so they
stop stepping on each other's toes.

## Why we need it (the real story)

I can have several sessions running at once against the same set of files (my
`.instar/` folder). Think of it like several cooks in one kitchen, all following the
same recipe, none of them aware the others are there. Two things actually went wrong
on 2026-05-28:

1. **The "still working" ghost.** One session finished a job but left a sticky note
   saying "still cooking: yes." A second session read that stale note and kept telling
   the user "I'm still working on it" — even though nothing was happening.
2. **The double-reaction (the bad one).** Both sessions noticed the same bug. One
   calmly built the proper fix. The *other* panicked and hit the emergency brake —
   flipped a feature off and cancelled 19 pending tasks. Neither knew the other was on
   it. Result: the bug got fixed, but the engine was left off and the test setup was
   wiped. Two correct instincts that, uncoordinated, undid each other.

The root cause is the same both times: **shared files, no traffic light.** Nothing
tells one session "hey, another you is already acting — wait a second."

## What we are building (and just as importantly, what we're NOT)

Justin chose the **light** option from a menu of light / medium / heavy. So this is
the gentle version, on purpose:

- **What it does:** Before a session does something high-impact (flip a feature flag,
  withdraw commitments), it can post a quick note — "I'm about to do X." Whenever any
  session takes such an action, the system hands back a little advisory warning if
  *another* session was just active: "⚠ another session withdrew 19 commitments 4
  minutes ago — confirm before proceeding."
- **What it does NOT do:** It never blocks anything. There are no hard locks. It never
  changes the thing you were trying to change. It's a heads-up, not a gate. If a
  session ignores the warning, the action still goes through.

That matches exactly what Justin asked for: "start small and learn to collaborate
slowly and smoothly," with cheap course-correction.

## How you'd actually see it

- A session announces intent: `POST /coordination/intent`.
- A session inspects what's been happening: `GET /coordination/recent`.
- The two risky actions from the incident — config-flag flips and commitment
  withdrawals — automatically record themselves and carry the warning back in their
  own response, so it works even if a session forgets to announce.
- It's quiet: no Telegram pings. Everything is logged to
  `logs/cross-session-events.jsonl` for later reading.

## What already exists vs. what's new

- **Already existed:** Single-commitment write safety (`CommitmentTracker.mutate()`
  uses a compare-and-swap so two sessions can't tear one record). That protects a
  single write — it does *not* stop two sessions adopting *opposite plans*.
- **New here:** the cross-session visibility layer — the shared scratchpad + the
  advisory warning that surfaces an opposing action before you commit to yours.

## What's deliberately left for later

- The stale "still working" ghost (incident #1) is a *separate* liveness bug, not a
  coordination problem. It's noted as a candidate next step, not bundled in here.
- Hard locks / leader election / one-session-in-charge — that's the heavy redesign
  Justin chose *not* to do for now.

## What the reader needs to decide

Really just one thing: is "light and advisory" the right first step, or do you want
something stronger (real locks) sooner? Justin already said light-first. If watching
it in practice shows the advisory isn't enough, the medium/heavy options are still on
the table — nothing here paints us into a corner.
