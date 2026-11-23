# The worktree watcher no longer crashes the server by reading an old, huge report at start-up

## What is going on

The agent's server runs a watcher that keeps a saved report about all of the agent's working copies. Until a fix that is now waiting to merge, that report kept every changed file name for every copy, and on the Mac Studio it had grown to 340 MB. Every time the server starts, it reads the saved report back in. Reading a file that big pushed the server's memory from about 1.3 GB to 4 GB in its first minute, and on 19 November at 00:11 the server ran out of memory and crashed. It had crashed the same way three times the day before.

The waiting fix stops new reports from growing large: about 2 MB on the Studio. But a machine that still has an old huge report on disk would read it once more at its next start, and could crash again.

## What changes

At start-up, the watcher first checks how big the saved report is. If it is over 16 MB, the watcher does not read it. It writes one line in the log saying so, and starts with no saved report. Its first scan, a few minutes later, makes a fresh report and replaces the old file.

## Safeguards

Nothing is deleted or moved. The only effect is that, for the first few minutes after a start, there is no previous report to compare against. That was already the case on a brand-new machine.

## What needs deciding

Nothing.
