# Build-Session Yield Safety — ELI16

## The problem, in one story

The agent spins up a background "build" session to do a job in its own copy of the code (a *worktree*). The session edits a bunch of files, kicks off the tests, and says "standing by for the tests to finish." But that kind of session ends the instant it stops typing — so it dies with all its edits **still on the floor, never saved (committed) to git**. The work is right there on disk, but nobody knows, so it sits invisible for hours while the user waits. That actually happened on 2026-06-12.

There are already two safety nets nearby, and neither catches this exact case:
- One net rescues **promises** ("I'll get back to you") when a session dies — but only if the promise was written down. Nobody wrote down "the build will commit its code," so there's nothing to rescue.
- Another net (**OrphanedWorkSentinel**, shipping now) **notices** a dead session's unsaved files and raises a flag — but only *after* the session is already gone, and it doesn't bring the work back to life.

## What this adds

Two small, composable pieces:

1. **Make "unsaved work in a worktree" a real wake-up signal.** When a session is shut down (for resource pressure, quota, age), the thing doing the shutting-down first peeks at the worktree: is there unsaved work? If yes, it tags the shutdown so the existing **resume queue** will bring that session back. Important guardrails: it only peeks for a few seconds and never lets a slow `git` jam up the shutdown; it ignores junk like build leftovers (`dist/`, `node_modules/`) so a noisy build can't trigger an endless loop; and it **never** overrides you — if *you* explicitly stop a session, it stays stopped, dirty worktree or not.

2. **When the session comes back, give it a tracked obligation — don't cage it.** An earlier draft of this design wanted to *block* the revived session from stopping again until it committed. We threw that out: a dumb "you may not stop" gate is exactly the kind of brittle, authority-grabbing rule instar is built to avoid (and the fact that we still needed a backup proves the cage wasn't really a guarantee). Instead, the revived session is simply *told*, in plain words at the top of its prompt, "you were brought back because you had unsaved work — commit it or deal with it," and the system opens a **tracked commitment** (the same machinery that nags the agent about promises) that keeps re-surfacing until the work is actually saved. And as a last-resort safety net, if the session dies *again* before saving, the system writes a **read-only backup patch** of the changes to a safe spot and raises one loud alert — it never quietly loses the work, and it never auto-commits secrets or junk into your git history on your behalf.

## Honest about what it is

This is **loss-reduction, not a magic guarantee.** A revived session can still die. The point is that when it does, the work is backed up and the alarm is loud — never a silent disappearance. It ships **enabled on developer agents and dark on everyone else's fleet** — the standard way new infrastructure proves itself: the dev machine is the controlled place it runs for real and matures before it's turned on more widely. (It *does* reach into the live session machinery — bringing sessions back and nudging commits — and the dev agent is exactly the bounded, watched environment where that's supposed to be exercised, not hidden from.) Every failure mode falls back to "today's behavior," never to a stuck session, and a dev operator can flip it off if it ever misbehaves.

## Multi-machine note

The unsaved work lives on one specific computer. If the conversation has since moved to a different machine, the system notices the worktree isn't there and stops cleanly instead of pretending — it never tries to revive work on a machine that doesn't have it.
