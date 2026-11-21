# Disk cleanup should not give up just because the computer is busy

## What went wrong

Each machine has a disk steward. When the disk runs low, it tries to free space by clearing caches that can be rebuilt, mainly npm's download cache, which was 6 to 10 GB on the Mac Studio. It won't clear that cache while npm is running, because that could break an install in progress. In that case it skips the cache and records the run as "npm was busy".

The steward also has a safety switch, called a breaker. If three automatic cleanups in a row free almost nothing, it assumes cleanup isn't working and stops trying until the low-disk episode ends. That's sensible for a cleanup that genuinely fails. But it also counted "skipped because npm was busy" as a failure. On a development machine, npm is busy almost all the time. On 17 November three busy skips tripped the switch, so automatic cleanup stayed off. On 18 November the Studio fell to 51.8 GB free against a 49.7 GB floor, while about 10 GB of npm cache sat there uncleaned.

## What this change does

A cleanup that only skipped work because a tool was busy no longer counts against the breaker. It never actually tried, so it can't have failed. The breaker stays where it was. Cleanups that did run and still freed almost nothing count exactly as before.

## Safeguards

- Nothing new gets deleted. The same categories, the same busy checks, and the same limits apply.
- A cleanup that genuinely doesn't work still trips the breaker after three tries.

## What needs deciding

Nothing. This is a small change to one counting rule, and a revert undoes it.
