# The disk cleaner reports what it really freed from the npm cache

## What is going on

The disk cleaner on each machine empties the npm download cache when it grows too big. It does this by running npm's own `npm cache clean` command. Tonight on the Mac Studio that command deleted almost everything: the cache went from 13.7 GB to 0.34 GB. But npm then exited with an error, probably because another program touched the cache partway through. The cleaner treated the error as "nothing happened", so it wrote 0 GB freed into its records.

That matters for three reasons:
- its report to people is wrong;
- its audit log is wrong;
- its safety brake, which stops cleanups that keep freeing almost nothing, counts a big success as a failure.

## What changes

After running npm's clean, the cleaner measures the cache folder again and records the difference as what it freed. If npm also reported an error, that error is kept too. If the folder can't be measured afterwards, a clean exit keeps today's answer and an error claims nothing.

## Safeguards

Nothing new is deleted. It is the same command, at the same moments, with the same checks for whether npm is busy. Only the number in the record changes, and it can only go down from what was planned, never up.

## What needs deciding

Nothing. It is a reporting fix.
