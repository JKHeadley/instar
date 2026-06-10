# ELI16 — Autonomous setup-race hardening

## What this is

Instar agents can run "autonomous sessions" — long-running jobs that work on a goal for hours and keep themselves going. Each such job keeps a little notes file (its "state file") describing what it's working on, how long it has left, and whether it's still active. A background hook reads that notes file every time the session tries to stop, and uses it to decide whether to keep the job going.

## What already exists

The system was **already** smart about running several autonomous jobs at once: the hook gives every job its **own** notes file, named after the chat topic it belongs to — `.instar/autonomous/<topicId>.local.md`. So two jobs running side by side normally never touch the same file. The hook also knows how to migrate an older single shared file into the per-topic layout when it sees one.

## What's new (the one small gap this closes)

There was a tiny timing gap. Right when a job **first started up**, the setup instructions told it to write into a single **shared** notes file (`.instar/autonomous-state.local.md`) first, and only a moment later did the hook move that into the job's own per-topic file. If two jobs happened to start in the same split-second, they could both scribble into that shared file and overwrite each other in that brief window — one job's notes could be lost before the move happened.

This change makes each job write **straight into its own topic-named notes file from the very first moment**, so there is no shared file to collide on at all. The part that reads the notes (the hook) didn't need to change — it already knew how to find each job's own file, and it keeps its safety net that migrates any old shared file left behind by an in-flight older job.

## The safeguards, in plain terms

- The hook (the thing that actually makes decisions about keeping a job alive) is **completely untouched** — only the skill's setup instruction changed.
- Agents that are **already installed** pick up this fix the next time they update (a migration re-deploys the corrected instructions), not just brand-new agents.
- The migration is safe to run over and over (it does nothing if the fix is already present) and never touches a skill someone has customized.
- If this turned out wrong, backing it out is a simple revert — nothing gets corrupted, because the hook's old-file migration safety net means a mixed fleet keeps working either way.

## What you actually need to decide

Whether to merge a small, internal robustness fix so concurrent autonomous jobs can never collide on a shared state file at startup. There is no user-facing behavior change.
