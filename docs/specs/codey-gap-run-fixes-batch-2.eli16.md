# Codey gap-run fixes, batch 2 — Plain-English Overview

> The one-line version: two more bugs Codey found — "script" chores were being run by firing up a whole AI session (which sometimes hung for hours), and retired scheduled jobs could come back from the dead — now fixed.

## The problem in one breath

Some scheduled jobs are plain shell chores (like "refresh a dashboard link") that need
no AI at all. Instar was launching a full AI session to run them anyway — and a couple
got stuck for 9 and 16 hours, holding a slot and never finishing. Separately, when a
built-in job was retired, it could fail to "cover" an old leftover copy of itself, so
the retired job quietly ran again.

## What already exists

- **The job scheduler** — runs scheduled jobs on a cron timetable. Most jobs are AI
  tasks that run in a session; a few are plain shell scripts.
- **Per-job manifests** — each built-in job has a small file describing it, which is
  supposed to take precedence over any older copy in the legacy job list.

## What this adds

1. **Script jobs now run directly as a quick subprocess**, not by launching an AI
   session. They finish in a bounded time, record their result, and never tie up a
   session slot — even when the system is at its session limit.
2. **A retired job's manifest now still "covers" its old leftover copy** even after its
   description file was deleted — so a retired job stays retired instead of coming back.

## The safeguards

**Nothing new is blocked.** The script job runs the exact same command as before, just
without the AI wrapper. The retirement fix only stops a disabled job from being dropped
(a disabled job never runs — it only shadows the old one).

**No regression.** AI jobs are unaffected; only "script" jobs take the new direct path.
Active jobs still require their description file. Both are covered by tests.

## What ships when

One small PR with both fixes. A third related fix (quieting repeated "no work to do"
log noise from a couple of jobs) is held for a separate change because it needs an
upgrade-migration to reach jobs already installed on existing agents.
