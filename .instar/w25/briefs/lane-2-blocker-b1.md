# W25 LANE 2 — BLOCKER B-1: stopping and deleting are two different actions

## Why this blocks the release

Twice on 2026-08-23 the sentinel's emergency-stop path did not merely STOP a session — it
DESTROYED that session's live state file. Two records over 200KB were lost in one day: the
orchestrator's at ~06:15Z and an observer's later the same evening. Each was recovered only
because someone had independently archived it minutes earlier.

This blocks the conversion release for a specific reason, not a general one: this window's whole
product is EVIDENCE that a deployment worked. A mechanism that deletes working records on an
emergency stop destroys exactly that evidence, and it fires on ordinary correspondence — both
of this day's firings were triggered by classifying a normal message as an emergency directive.

## The fix, stated as behaviour rather than implementation

Stopping a run and deleting its live state file become SEPARATE actions. An emergency stop must
stop the run and PRESERVE the file. Nothing about this asks you to weaken the stop: it must remain
just as immediate and just as complete at halting work. It must simply stop destroying the record
of what the work was.

## Start by measuring, not by editing

The orchestrator has read one relevant thing and is handing it to you so you do not start blind,
but it is a POINTER, NOT A FINDING — verify it before you build on it:

`.instar/w24/recovery/WINDOW-CLOSE-PROCEDURE.md` records that
`stopAutonomousTopic(stateDir, topic)` deletes `<topic>.local.md` and
`stopAllAutonomousJobs(stateDir)` deletes every `*.local.md`, quoted from
`dist/core/AutonomousSessions.js:283`. That same file then CORRECTS ITSELF: after a real run-end
at 19:13:29Z the live log was NOT deleted, so run-end is a different path from stop.

So: at least one path deletes and at least one does not. Establish EXACTLY which paths delete,
with a control that could have shown otherwise, before changing anything. Find the actual
emergency-stop path the sentinel invokes — the two incidents are in `logs/server.log` around
`06:15:36Z` (search `sentinel emergency-stop`) and again that evening. Do not assume the sentinel
calls the same function the close procedure quotes.

## The bar

Per the project's Testing Integrity Standard this needs ALL THREE tiers, and the standard is
non-negotiable:
- unit: the stop path preserves the state file
- integration: the behaviour holds through the real call path, not a mock
- e2e/lifecycle: an emergency stop on a live-shaped run halts it AND leaves the record intact

**The test that matters most is the must-fail control:** a test that FAILS if your fix is removed.
Write it and prove it fails against the unfixed code. A test that passes both with and without
the fix has measured nothing.

Also confirm you have not weakened the stop: after your change, an emergency stop must still
actually stop the run. Measure that too, with a control.

## Where to work

Your own worktree, created with the project's own tool so it lands in the sandbox-safe location:
    cd /Users/dabombstudio/.instar/agents/echo
    node .instar/shadow-install/node_modules/instar/dist/cli.js worktree create w25-b1-stop-preserves-state
Branch from `main`'s current tip unless you can show a reason not to. Say what you branched from.
NEVER edit the live agent home's working tree.

## What you must NOT do

No push, no merge to main, no PR, no deploy. Do not disable the sentinel, do not change what it
classifies as an emergency, and do not touch its thresholds — the classification question is real
but it is NOT yours and not this window's. You are separating stop from delete, nothing else.

## Report to

`/Users/dabombstudio/.instar/agents/echo/.instar/w25/lane-2-blocker-b1.md` — write as you go.
Include: which paths delete and which do not, each with its measurement; your branch name and
base; the must-fail control and proof it fails without the fix; and anything you found and
deliberately did not fix.
