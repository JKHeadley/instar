# ELI16 — the cleaner that could never find the room

## What was supposed to happen

When I create a working copy of the codebase to build something in, it goes in a standard place under my
home directory. They pile up — each one is a full copy of the source tree. So there is a background
housekeeper whose job is to notice which ones are finished (the work is merged, nothing uncommitted, nothing
running in them) and reclaim the disk.

## What actually happened

The housekeeper reported: `enumerationFailures: 98`. Ninety-eight consecutive attempts, none of which
managed to look at anything. Meanwhile there were 45 working copies taking up **27 gigabytes**.

To list working copies you have to ask a *repository*. The housekeeper was handed a path that is not a
repository at all — my home directory. Every attempt came back "fatal: not a git repository", so it looked at
nothing, forever.

Worth being precise about who did what wrong here, because a previous fix in this area was correct and is the
only reason I noticed. The housekeeper's status output **does not lie**. It says `enumerationOk: false` and
refuses to report a number of reclaimable items, with a comment in the source explaining exactly why: *"the
check could not run" and "there is nothing to reclaim" are the same bytes to a reader and opposite facts.*
That honesty was added in July after this same thing happened with 73 working copies. It worked — I found
this by reading it. What was never fixed was the wrong path underneath.

## The second, quieter version of the same bug

There is a separate routine whose job is to work out where the repository is. It tried two conventional
locations — `~/Documents/Projects/instar` and `~/instar`. Neither exists on this machine, so it returned
"don't know", and every caller had a line like `if (we know the repo)` and skipped. Silently. No errors, no
count of failures, nothing.

Both bugs are the same mistake: **a path assumed instead of resolved.**

## The fix in this change

The answer was sitting on disk all along. Every working copy contains a small file that names the repository
it belongs to — one line, e.g. `gitdir: /path/to/the/repo/.git/worktrees/my-branch`. So instead of guessing at
conventional locations, ask the working copies. They know.

This change adds that ability and proves it works. It does **not** yet plug it into the housekeeper — see
below.

## The bug I put in my own fix, and how I caught it

My first version asked *every* agent on the machine, not just mine. There are several agents here, each with
their own working copies. Whichever agent had the most won the vote — so when I actually ran it, my agent
resolved to **a different agent's repository**.

That is worse than the original bug. "I don't know" makes a caller skip and do nothing. A confident wrong
answer makes it *act*, on someone else's files.

I only caught it because I ran the thing and printed both results side by side, rather than reading my own
code and believing it. The fix: there is now no default at all — a caller must name its own directory, and a
test fails if resolution ever wanders off to somewhere the caller did not name.

## Something honest about the answer

While measuring, I found this agent's working copies do not all belong to one repository. Twenty-nine belong
to one clone and seventeen to another — both legitimate, both copies of the same project. So "which repo owns
the working copies?" does not have a single answer here.

The function returns all of them, biggest group first. A caller that only looks at the first gets the largest
consistent set — better than nothing at all, and still not everything. That limitation is written into the
function's own documentation rather than left for someone to trip over.

## Why the housekeeper is not fixed yet in this change

Plugging this in would change what a background process with **permission to delete directories** operates
on. Given that my first attempt at this exact resolution produced a wrong answer, "easy to get wrong" is not
a theory here — it is the measured behaviour of my own first draft. So that step goes through the heavier
review path with the operator's approval, as a small focused change on top of this one, rather than being
bundled in at the end of a long session.

What lands here is the mechanism, tested and verified, with nothing calling it yet — so no agent's behaviour
changes at all today.

## How you know it works

Fourteen tests. They cover the real shapes: a normal pointer, several working copies agreeing, two different
repositories being reported in the right order, and the whole list of things that must produce "don't know"
rather than a guess — a full clone sitting in the wrong place, a corrupted file, a folder with nothing in it,
a missing directory. Plus the cross-agent bug above, pinned so it cannot come back. The existing tests for
this file were not modified and still pass, which is what tells you the old behaviour is untouched when no
caller opts in.
