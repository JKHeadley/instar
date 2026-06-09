# Autonomous "Legitimate Stop Conditions" — plain-English overview

## What this change is

When an agent runs in **autonomous mode**, the operator has pre-approved it to work
on its own for a set amount of time (say, 24 hours) without someone watching the
keyboard. The point is that the agent keeps going and gets the whole job done.

The problem: agents kept **stopping early** for bad reasons — "this feels like a
clean milestone," "this decision needs your steer," "it's late." The operator was
disappointed, because none of those are real reasons to stop a pre-approved session.
His exact guidance: *"Decisions are not that critical. They can always be undone or
redone. This is also why we ship safely in dark mode so we can test and iterate. So
decisions are not critical and autonomous mode should use its best judgment."*

This change adds a new section to the autonomous skill's instruction file (SKILL.md)
called **"Legitimate Stop Conditions (the ONLY valid reasons to exit)"**. It spells
out the only three valid reasons an autonomous session may stop:

- **(a)** A genuine HARD external blocker the agent cannot resolve itself — a
  credential that doesn't exist, a service that's down, data that isn't there yet,
  or an action a safety rule actually forbids.
- **(b)** The duration ran out (the session clock genuinely expired).
- **(c)** The work is genuinely done (the completion condition/promise is true).

Everything else is a **NON-stop** — the agent should make its best-judgment call and
keep working. The new section includes a clear table of these NON-stops (reversible
decisions, milestones, late-hour, "needs your steer/opinion," "good stopping point,"
and quietly winding down with no reply). It also strengthens the existing
"Anti-Patterns" list with two new traps: "This Needs Your Steer" and "Quiet Off-Ramp."

## What already exists

The autonomous skill already had a stop hook (structural enforcement) and a
"Defer-to-Future-Self Trap" section. This change does NOT touch the stop hook's
blocking logic — it only adds and strengthens the prose guidance the agent reads.

## What's new

1. The new SKILL.md section + two new anti-pattern entries (the shipping source that
   new agents get when they run `instar init`).
2. An idempotent migration in PostUpdateMigrator so **existing** agents receive the
   new section when they update (not just brand-new agents). It re-deploys the
   bundled SKILL.md only when the installed copy lacks a unique sentinel
   (`LEGITIMATE_STOP_CONDITIONS`) AND still looks like the stock skill — a customized
   skill is left alone, and running it twice changes nothing.
3. Four unit tests proving the migration adds the section when missing, is a no-op
   when present, skips customized files, and is a no-op when no file is deployed.

## Safeguards in plain terms

- It is content-only — no code that blocks or gates anything was changed. If the
  guidance is wrong, the rollback is just reverting the prose; no data, no state.
- The migration never overwrites a customized skill, and it's safe to run repeatedly.

## What you need to decide

Whether the three legitimate stops (hard blocker / duration expiry / completion) and
the list of NON-stops match how you want pre-approved autonomous sessions to behave.
