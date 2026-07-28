# ELI16 — Letting the worktree-cleanup robot actually do its job

## What this is, in plain English

Instar makes lots of "worktrees" — extra full copies of the project's code that
pile up on disk (there were 100+ on the dev machine). A while back I built a small
robot, the AgentWorktreeReaper, that finds the ones that are completely safe to
delete — meaning the work in them is already saved into the main project, there are
no unsaved edits, and nothing is using them right now — and removes them to free
disk and reduce how much the Mac has to index.

The problem: the robot never deleted anything, and it always reported "0 to clean
up," even when 50 were obviously safe to remove.

## Why it was stuck

Instar has a safety wall called the SourceTreeGuard. It exists because of a real
past incident: it stops the program from running dangerous git commands against its
own source code. The robot lives *inside* instar, and the folder it cleans up sits
right next to instar's own code — so the safety wall treated every single thing the
robot tried to do as "a dangerous command against our own code" and blocked it.

The robot needed four git commands: "list the worktrees," "is this one clean (no
unsaved edits)?", "is this one's work already saved into the main branch?", and
"remove this one." All four were blocked. Worse, the "is the work already saved?"
command (`git cherry`) wasn't even recognized as a harmless read, so it failed
instantly — and the robot interpreted that failure as "not safe, keep it." That's
why it always said zero.

## What changed

I taught the safety wall to recognize exactly these four commands as allowed *for
this specific cleanup job* — and nothing more:

- The three read-only commands (list, check-clean, check-already-saved) are now
  recognized as harmless reads.
- The one command that actually deletes a worktree is allowed **only in its safe
  form**. Normally `git worktree remove` refuses to delete anything with unsaved
  edits. There's a "--force" version that ignores that and deletes anyway — and
  that forced version is **still blocked**, so the robot can never destroy unsaved
  work even by accident. The robot never asks for the forced version.

Everything else the safety wall blocked before, it still blocks. The robot's own
rules are unchanged: it still only deletes worktrees that are saved AND clean AND
not in use, and it still ships turned off + in "dry run" (just report, don't delete)
by default.

## What you need to decide

Nothing risky here. This is the second half you already said yes to ("yes, both").
The safeguard is concrete: the only deleting command allowed is the one that
refuses to touch unsaved work, and the dangerous forced variant stays walled off.
The change is pure code — no settings, no migration — so undoing it is just
reverting one commit, and the robot goes back to reporting zero. The real proof is
live: after deploy, the cleanup report should show a real number instead of 0.
