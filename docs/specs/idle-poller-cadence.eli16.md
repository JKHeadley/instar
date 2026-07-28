# ELI16 — Idle-aware poller cadence

## What this is, in plain English

Every instar agent has a couple dozen little background "checkers" that wake up on
a timer and do a small job — scan some logs, peek at a session, update a tally.
That's fine when the agent is busy. But when the agent is just sitting there with
nobody talking to it, those checkers STILL wake up on the same fast schedule and
do work for no reason. Multiply that by a couple dozen checkers times nine agents
all running on one laptop, and it's a steady, pointless drain on the machine.

## What already exists

The checkers each run on a fixed timer (for example, the token-usage scanner runs
every 60 seconds, always). There was no notion of "the agent is idle, so slow
down."

## What's new

A small reusable gadget called IdleAwareCadence. You give it two speeds — a fast
one for when the agent is active and a slow one for when it's idle — and a way to
ask "are we idle right now?" It runs the job on the fast schedule when there's work
and the slow schedule when there isn't, and it speeds back up the moment things get
busy again.

The first checker to use it is the token-usage scanner: when no session is running,
there are literally no new tokens to count, so it now slows from every 60 seconds to
every 5 minutes. The mechanism is built so the other checkers (and, later, a full
"agent sleep" mode) can adopt it one at a time.

## The safeguards, in plain terms

- It only changes how OFTEN a checker runs, never WHAT it does — so it can't break
  anything or miss real work; the worst case is "we didn't save as much CPU."
- If the "are we idle?" question ever errors out, it assumes the agent is ACTIVE and
  keeps the fast schedule — it never slows down when it's unsure.
- If a checker's job throws an error, the loop just keeps going.
- The other checker that doesn't opt in behaves exactly as before.

## What you actually need to decide

Nothing. This is automatic and conservative. You should just see a little less idle
CPU from each agent, and it lays the groundwork for the bigger "idle agents cost
almost nothing" goal.
