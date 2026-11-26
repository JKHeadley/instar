# The job checker's opt-out never reached it — plain-English overview

## What Changed

The job-completion audit (merged this morning, switched off by default) lets a
job say two things about itself: "don't audit me" and "here are the files I
promise to produce". Both are written at the top of a job's file.

But that is not where the running system reads them. When a job is installed,
its settings are copied into a separate small settings file, and the scheduler
reads only that copy. The copier didn't know about these two new settings, so
it silently dropped them. Anything a job declared about the audit was ignored.

The worst case was the audit's own batch job. It declares "don't audit me",
precisely so the checker never ends up checking itself — a loop that wastes
budget and produces meaningless records. That declaration was being dropped
too, so on a real machine it would have audited itself.

This change teaches the copier about both settings and adds two tests: one
that the copier carries them, and one that reads the actually-installed
settings file for the audit's own job and checks it really says "don't audit
me". The second test is the one that matches how the bug was found — by
looking at the installed file on a real machine rather than at the source.

## What to Tell Your User

Nothing changes for you. A setting in the new job checker wasn't reaching the
part of the system that uses it, including the rule that stops the checker
checking its own work. It does now.

## Summary of New Capabilities

- A job's "don't audit me" and "files I promise" settings now reach the
  scheduler instead of being dropped during installation.
- The audit's own batch job is genuinely excluded from its own audit.
- Two tests pin both, one of them reading the installed file rather than the
  source, which is what would have caught this.

## What you actually need to decide

Nothing. This restores behaviour the approved design already specified; it
adds no new capability and changes nothing that is switched on.
