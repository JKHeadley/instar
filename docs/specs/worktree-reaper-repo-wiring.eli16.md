# ELI16 — the housekeeper that was handed the wrong address

## The job

Every time I build something, I make a separate working copy of the codebase. They accumulate — each one is a
full source tree, hundreds of megabytes. So there is a background housekeeper whose job is to spot the ones
that are finished (the work is merged, nothing uncommitted, nothing running inside) and reclaim the space.

## What went wrong

To list working copies you have to ask a **repository**. The housekeeper was handed my home directory, which
is not a repository — the actual repository lives in a subfolder. So every attempt came back "that isn't a
repository", and it reclaimed nothing. Ninety-eight times in a row, while 45 working copies grew to **27
gigabytes**.

The same wrong address is given to a second watcher, the one that notices when a build died leaving unsaved
work behind. It has been equally blind.

## The part that already worked, and deserves saying

The housekeeper's status **does not lie about this**. It reports "I could not look" and pointedly refuses to
give a number, because — in the words of a comment in its own source — *"the check could not run" and "there
is nothing to reclaim" are the same bytes to a reader and opposite facts.*

That honesty was added last month, after this exact thing happened with 73 working copies. It is the only
reason anyone noticed this time. What was fixed then was the **reporting**. What was never fixed was the
**wrong address**, which is what this change is for.

## The fix

A working copy contains a small file naming the repository it belongs to. So instead of being told an address,
the housekeeper can ask its own working copies where they came from. That ability was built and merged
separately, deliberately switched off, with nothing calling it. This change is the part that plugs it in.

If the answer cannot be worked out, it falls back to exactly what it does today — so an agent where this makes
no difference sees no difference.

## Why this needs a person to approve it

Two reasons, and the second is the honest one.

First, this hands a new address to a background process that has permission to **delete directories**. The
rules about *what* it may delete are untouched — merged, clean, nothing running — so a wrong address cannot
make it delete something in use. But it decides which set of things it looks at, and that deserves a second
pair of eyes.

Second: **my own first attempt at this got it wrong.** I wrote it so that it asked every agent on the machine
rather than just me — and when I actually ran it, my agent resolved to *a different agent's repository*. That
is worse than the original bug, because "I don't know" makes something skip, while a confident wrong answer
makes it act. I caught it by running it and printing the answers side by side, not by reading my own code.
"This is easy to get wrong" is not a caution I am adding for form's sake; it is what my first draft actually
did.

The automated check would have let me ship this without any of this paperwork. I asked for the heavier path
because of that measured mistake, not because a rule required it.

## Something I found and did not fix

While checking, I noticed the health display has a state meaning "this guard cannot see" — and a guard in
trial mode can never reach it, because trial mode is checked first. So a guard that is both in trial mode and
blind is displayed simply as "in trial mode". The blindness is there, but one level down.

That matters because trial mode is exactly when you are supposed to be finding out whether the guard works
before you switch it on. A guard blind for its whole trial looks like a clean trial.

I have not changed it. The person who wrote that line knew — there is a comment accepting the same trade for a
different signal — and reordering it would change how guards are classified everywhere, possibly setting off
new alerts on other machines. That is a decision for the operator, so it is written up as a question rather
than smuggled in with the fix.

## What is not covered

This agent's working copies turn out to belong to **two** different clones of the same project — 29 to one, 17
to the other. The housekeeper only understands one repository at a time, so it will handle the larger group
and still not see the smaller one. Better than nothing at all, and not everything, which is why it is written
down here rather than left to be discovered later.
