# Plain-English overview: stop scanning the whole codex history

## What was wrong

We just shipped a feature that reads codex's usage limits from the log files
codex writes to disk. To find the newest log, the code listed EVERY log file,
checked the timestamp on each one, sorted them, and took the newest. That's fine
when there are a few hundred logs. But a busy codex account piles up a LOT —
the machine we tested on had **14,277 log files taking 1.4 GB**. Checking every
single one, one at a time, on a busy server, took so long that the usage check
just timed out and returned nothing. So a feature that worked in testing fell
over on real, heavy usage.

## The fix

Codex stores its logs in folders by date: year / month / day. So instead of
reading every file ever, we now open the folders newest-day-first and only look
inside the most recent day or two — exactly where the newest log has to be. As
soon as we've found enough recent logs (and looked at at least the two newest
days, so we don't get tripped up right after midnight), we stop. We never touch
the thousands of old files.

If a codex account ever stored its logs in some other shape we didn't expect,
the code quietly falls back to the old thorough scan — correctness first.

## Did it work?

Yes. On that same real 14,277-file account, the old way timed out after 30+
seconds. The new way finishes in **59 milliseconds** — it looked at the two
newest day-folders and stopped. It returns the exact same answer, just without
reading the entire history.

## Is anything risky?

No. This only changes HOW we find the newest log — it reads less of the disk to
get the same result. It doesn't change any behavior, doesn't make any decision,
and doesn't touch anything other than the file scan. The same fix also speeds up
three other places that used the same "list the newest logs" helper (the token
ledger and the session-resume lookup). If we ever needed to undo it, it's a
single self-contained revert with nothing else to clean up.

## What you'd notice

The "how much codex usage is left?" check now answers instantly even on a heavy
account, instead of hanging.
