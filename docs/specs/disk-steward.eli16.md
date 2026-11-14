# Disk Steward — plain-English overview

## What happened

On 7 November 2026 the Mac Studio's disk got to 95% full. The Instar app refused to accept an upload, because uploads stop when less than 5% is free. Nobody had been warned. Justin asked for a dedicated job and topic that looks after disk space on every machine, so this never happens again.

## What already exists

- A worktree cleaner (the "reaper") meant to remove finished copies of the code. It had a bug: it treated build folders like `node_modules` and `dist` as unsaved work. Every copy has those, so it never removed anything.
- Local Verify, which makes a fresh copy of the code for each test run and deletes it at the end, but only when the run finishes normally. A restart in the middle left the copy behind for good.
- Scheduled jobs. These can't do this job, because standby machines (the ones not currently answering Telegram) don't run scheduled jobs.

## What is new

1. **A watcher on every machine.** It runs inside the agent server itself, so standby machines are covered too. Every 15 minutes it checks how much space is free and how fast that is shrinking, and estimates how many days remain until the 5% danger line.
2. **Clean first, then warn.** When space drops under 15% (or 100 GB), it first clears two kinds of safe tool cache: npm's download cache when it is over 5 GB, and Xcode build files older than a day. If that fixes it, it says nothing. If space is still low, it posts plainly in the "Disk space (all machines)" topic: which machine, how much is free, how fast it's going, what it cleared, what it is keeping and why, and what you can say to get more cleared. Under 10% (or 60 GB), or when the disk is on track to fill within 3 days, it repeats more often. At the danger line itself, the warning always gets through.
3. **One voice.** Standby machines never post. The awake machine reads each machine's numbers and writes the post itself.
4. **The cleaning is switched on only for development agents** (like Echo) at first. Everyone else gets the warnings, and the cleaning is offered to them. It goes wider only after two weeks of clean records.
5. **Two leak fixes.** Local Verify now sweeps up its own leftover test copies at the start of each run. The worktree cleaner no longer treats a linked dependency folder, or a `dist/` it can prove came from a build, as unsaved work.

## Safeguards in plain terms

- Only two cache folders are ever cleared. Nothing else on the disk has a path to deletion: no worktrees, no agent memory or state, no files of yours.
- Every cleaning rule keeps things when in doubt. If a build is running, or the process list can't be read, it skips.
- A worktree that anything else links into is always kept. Review found that 189 worktrees on the Studio share one set of installed packages through links, and some 2.0 pipeline folders link into worktrees too.
- A real `node_modules` folder is always kept, because it might hold hand edits. A `dist/` is kept unless every file in it matches a source file and was written in the same build.
- Cleaning runs in a separate, time-limited process, so it never freezes the agent.
- Every cleanup writes a record of exactly what it removed.

## What to expect honestly

On the Studio today, the watcher frees space mainly from the npm cache and Xcode files. The worktree fix is now correct and safe, but it frees only a few worktrees right now, because most of them hold other leftovers it doesn't yet know are safe. Those leftovers, and worktrees held by old session locks, each have their own filed feedback item (fb-4ee99a20-35b and fb-f564e836-6ca). The biggest user of space, the 2.0 pipeline's backups, is being raised with its owner separately.

## What you need to decide

Nothing, apart from one small step after it ships. Echo's disk posts land in the quiet feed until Justin says he wants them as notifications. The agent will ask in the topic, and a "yes" switches that on.
