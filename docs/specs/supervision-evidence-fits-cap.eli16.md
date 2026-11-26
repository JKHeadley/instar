# Job evidence that fits its size limit (ELI16)

Some scheduled jobs now run as small scripts instead of full AI sessions, which saves a lot of money. After each script run, a short summary of what it found is put together for a reviewer. That summary has a size limit of 2,000 characters.

The health check (it runs every few minutes) reports every warning the server has. When there were many warnings, its summary went over 2,000 characters. The system treated that as "this script broke its contract" and put the job on hold. A held job falls back to running as a full AI session, which is the expensive way the scripts were meant to replace. The health check has been stuck like that since 13 November.

This change makes the summary fit the limit instead of failing. It always keeps the job's result, its named readings and any outside confirmation. Then it lists as many warnings as fit, and if some don't fit it says so plainly ("12 of 40 warnings left out"). The free-text tail of the output gets whatever room is left; that tail is the least important part, so it shrinks first.

One safety point stays: if any warning was left out, the summary is never treated as enough to close the run as routine on its own. The reviewer still looks at it.

Nothing else changes. A broken script (missing result line, garbled output, unknown fields, secrets in the text) is still refused exactly as before.

**Status.** Small fix (Tier 1), part of an owed promise (CMT-1610). After this is installed, the health check's existing hold is released with a recorded reason so it runs as a script again.
