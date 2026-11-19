# Two job tests that failed on a busy computer, not on a broken product

## What this is

Before any change to Instar is merged, a full set of automatic tests runs on a test machine. Two of those tests check how scheduled jobs are started. On the evening of 2026-11-15 they failed four times in a row on one machine (a busy Mac Studio) for changes that had nothing to do with jobs, while the same changes passed on a second machine. Each wrongful failure cost a 25 to 35 minute run and held up the change.

## What went wrong

There were two different causes.

**The first test depended on how much memory the machine had free.** Instar refuses to start a new job when the computer is short of memory. That is a real safety feature. But the test started a real server, and that server asked the real computer how full its memory was. On a machine above 75% in use, the server refused every job the test tried to start, and the test reported a failure. A setting in the test that looked like it switched memory checking off did not actually do so.

**The second test depended on the clock.** It started a scheduler loaded with 26 built-in jobs, each on a real timer, and then counted exactly how many sessions were started. If one of those timers happened to fire while the test was running (two of them fire every five minutes), an extra session appeared and the count was off by one.

## What changes

Only the two tests change. No product code changes.

- The first test now sets the memory limit itself, in the same settings file the product reads at start-up, to a value that can never be reached. The computer's real memory no longer decides the result. A new final step then sets the limit to zero and checks that the job is refused, recorded as refused for memory, and that nothing was started. So the safety feature is still tested, on purpose, instead of by accident.
- The second test no longer starts the timers. It starts each job directly, which is all it ever needed, and it checks that the timers are off.

## What keeps it safe

The memory guard in the product is untouched and is now tested on both sides: jobs are admitted when memory is fine and refused when it is not. No test was removed or skipped. Each fixed test passed three times in a row on the busy machine while it was at 83% memory in use, and three more times at 61%.

## What you need to decide

Nothing. One thing was found and left alone for a separate change: the setting named "memory monitoring" does not switch the job memory guard off, which may surprise someone who sets it.
