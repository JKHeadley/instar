# Old conversation copies: stop the leftovers, and measure what's safe to clean up (plain-English overview)

## What this is

When an agent works on code for a conversation, Instar makes it a private working copy of the code, called a "worktree", so conversations never step on each other. Nothing ever cleans these copies up. On the Mac Studio there are about 100, and with the other leftovers in the same folder they take about 70 GB.

## Why it can't just be cleaned up yet

The first review of a "clean up old copies" design found that it isn't safe or simple:

- **Every copy carries files the cleaner can't tell from real work.** Instar leaves a few small files of its own in each copy, and sometimes a full copy of the code's libraries. The existing cleaner counts all of that as unsaved work, so it would keep almost everything. Only about 18 of the 101 copies would even look clean.
- **A name isn't proof.** Some copies that look like conversation copies were made by hand.
- **Copies link into each other.** Removing one could break another.
- **The existing cleaner does its checking on the server's main thread,** which can freeze the server.
- **The "in use" notes are never removed,** so they mean nothing.

## What this change does

1. **Clears the "in use" notes when a conversation finishes or is stopped.** They are not cleared at server start, because a conversation that keeps running across a server restart still needs its note to sign its work.
2. **Gives all cleaners one map of which copies link into which,** across both folders. It also fixes two hidden bugs in the existing cleaner: one would crash it the first time a removal failed, and the other would count work merged into the wrong branch as finished.
3. **Marks library copies,** so a future cleaner can tell a rebuildable library copy from real work.
4. **Measures without deleting anything.** A separate background process, not the server, works out:
   - which copies are provably safe to remove, and how many bytes that is;
   - separately, how much more could be removed if copied library folders were accepted as rebuildable;
   - why each other copy has to stay.
   Every "safe" verdict is double-checked a second way. Disagreements are recorded, and so are the cases the second check can't settle on its own.

The disk report then shows those numbers.

## What comes next

Actually removing copies is a second step with its own design, built on these measurements. If only a few gigabytes turn out to be safely removable, that step may not be worth its complexity. The numbers will show it.

## Safeguards

- **Nothing is deleted by this change.**
- **The measuring runs off the server's main thread,** in the disk report's existing background process. (The existing cleaner's freeze is being fixed separately and first.)
- **Anything the measurement can't read counts as "keep".**

## What needs deciding

The Chief of Staff approves the design. No operator action is needed.
