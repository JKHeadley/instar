# ELI16 — WS4.3 role-guard-at-spawn (a state-writing job can't run on the wrong machine)

## The problem

When I run on more than one computer, exactly one of them is "in charge" at a
time (it holds a token called the *lease*). The other is a standby — it is
deliberately read-only, so two computers can't both scribble on the same shared
notebook and corrupt it.

My scheduled jobs are a problem here. The job scheduler only starts up on the
in-charge computer. But here's the gap: if that computer LOSES the lease while
it's still running (it gets demoted to standby mid-shift), nobody turns its
scheduler off. Its cron timers keep ticking. So a job that WRITES to the shared
notebook could fire on a computer that is now supposed to be read-only — the
exact double-writer corruption the standby rule exists to prevent. It's a
classic timing hole: the scheduler checked "am I in charge?" at startup, but the
answer can go stale before the job actually runs.

## What this change does

Right before the scheduler spawns a job, it re-checks — at that very moment, not
at startup — two things:

1. Is this a STATE-WRITING job? (The job opts in by marking itself
   `"writesState": true`.)
2. Do I currently hold the lease?

If it's a state-writing job AND I do NOT hold the lease, the scheduler refuses
to start it, writes down why ("role-guard" skip), and raises one calm heads-up
note. The job isn't lost: the cron timer fires on EVERY computer, and the one
that actually holds the lease passes the check and runs it. So the refusal
re-routes the work to the right machine all by itself.

It's the same kind of just-in-time re-check the message router already does
before it spawns a session — catch the stale answer at the last possible moment.

## Why it's safe to ship

It's dark by default (behind a flag), and it only ever affects jobs that
explicitly mark themselves state-writing. On a single computer you always hold
the lease, so it never fires. If the flag is off, or the check itself errors, the
job spawns exactly like today — the guard can only ever REFUSE work that would
have been unsafe, never block work that was fine.

## Parent principle

Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions.
