# The worktree watcher stops re-asking git the same questions every five minutes

## What is going on

Every five minutes, the agent's worktree watcher checks every working copy of the code: how many commits it has that the main line doesn't, which files they change, and how old its newest commit is. Each check starts a separate git program. With about 430 working copies on the Mac Studio, that is over 850 git programs every five minutes, even when nothing has changed. That costs the machine processor time and memory for no new information.

## What changes

Those answers depend only on two things: the working copy's newest commit, and the main line's newest commit. The watcher now remembers each answer under those two commits. On the next scan, if neither has moved, it reuses the answer instead of asking git again. A commit's age never changes, so that is remembered too. When something does change, such as a new commit on the copy or on the main line, the watcher asks git afresh.

On a quiet scan, the cost drops from about 850 git programs to about three.

## Safeguards

The remembered answers are tied to exact commits, so they can never be out of date for a commit that moved. Memory for working copies that no longer exist is dropped on the next scan.

## What needs deciding

Nothing.
