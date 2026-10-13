# Single-instance lock: pid reuse — Plain-English Overview

> The one-line version: an agent decides "a copy of me is already running" from an operating-system ID number that the machine hands out again every few minutes, so a dead copy's number keeps looking alive and the agent refuses to start for hours — it must check the start time too.

## The problem in one breath

Only one copy of an agent may run at a time. The starting copy checks that by looking up the ID number written down by the last one and asking the operating system "is anything with that number still running?". On a busy machine that question has the wrong answer: ID numbers get reused. The `inspec` agent on Justin's laptop was dark for about thirty-five hours over one weekend and another three and a half hours the next day, with its keeper process healthily relaunching it and every launch quitting within a second, because a long-dead copy's number kept landing on some unrelated live program.

## What already exists

- **The single-instance lock** — a small file each agent writes when its server starts, holding the ID number and the machine name of the running copy. A second copy reads it and stands down rather than becoming a duplicate. It exists because three concurrent copies of one agent turned a 2026-06-20 runaway into a machine-wide outage.
- **The keeper process (the lifeline)** — watches the server, relaunches it when it dies, and gives up for five minutes after five failures in a row before trying again.
- **The crash log** — the server's error output is copied to a file so a launch that dies instantly can still be explained afterwards.
- **A stale-lock cleanup** — if the recorded copy is genuinely gone, the next copy takes the lock over. That is the path that was never reached here.

## What this adds

The lock now also writes down **when** the running copy started, and a starting copy has to match both. Two programs can share an ID number; they cannot share an ID number and a start time. If the start time is far off, the note is from a copy that is gone and the new copy may take over.

Secondary change: the crash log now **adds to** the file instead of replacing it. Every failed launch wrote down why it failed and the next failed launch wiped it, so after hours of failures the file described an unrelated earlier launch. That is the single reason this took hours to explain rather than minutes. The file is capped so a tight failure loop cannot fill the disk.

## The new pieces

- **The recorded start time** — the holder's own start, to the nearest second. It is written when the lock is taken and read back by the next copy. It is *optional in the file format*, so a lock written by an older version is still readable and simply behaves the way it always did.
- **The start-time reader** — asks the operating system how long a given ID number has been running and works backwards. It uses the elapsed-time field rather than the printed date, because elapsed time reads the same in every language setting. It is allowed three seconds, runs once at startup, and never on a path that serves a request.

## The safeguards

**Prevents a live copy being declared dead.** That is the dangerous direction — it would let two servers run, which is exactly what this lock exists to prevent. So the start times have to differ by more than ten seconds before the lock is treated as stale. Real jitter between the two ways of measuring is under a second; ID-number reuse happens minutes apart. The window is comfortably in between.

**Prevents a stricter check from making things worse.** Every uncertain case keeps the old behaviour. A lock file with no start time (written before this change) and a start time that cannot be read (the process vanished mid-check, or the command failed) both fall back to the ID-number-only answer. The change can only ever make the agent *more* willing to start, never less, and only on evidence.

**Prevents the disk filling.** The crash log now appends, so a failure loop that previously wrote one line could now write thousands. It is truncated before a launch once it passes four megabytes.

## What ships when

One change, one pull request. There is no phasing: the lock format gains an optional field that old code ignores and new code treats as "unknown", so the version an agent happens to be on does not matter during the rollout.

## What you actually need to decide

Nothing is being asked of you — this is a bug fix to an existing guard with no new setting, no new surface and no migration. The only judgement worth checking is the ten-second tolerance: it is the line between "two different programs" and "the same program measured twice", and it is set wide on purpose because the costly mistake is the other way round.
