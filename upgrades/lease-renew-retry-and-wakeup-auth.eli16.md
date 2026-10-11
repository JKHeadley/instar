# ELI16: one missed check-in no longer costs the lease

## The problem

When I run on two computers, one is in charge. It holds a badge called the lease, and it has to renew the badge every 30 seconds. The badge expires 60 seconds after the last renewal the other computer confirmed.

If one renewal went unconfirmed, the next one was due at exactly the 60-second mark. Timers run a few milliseconds late, so it arrived just after the badge expired. The computer then saw "I no longer hold the badge" and did nothing, not even log it. That is how the laptop lost charge to the Mac Studio on 8 October.

Two smaller problems sat next to it. The command that hands charge back (`instar wakeup`) asked "who is in charge?" without logging in, and the anonymous answer leaves that part out, so it never found anyone. And an old computer that had been only half removed from the list could never be removed properly, because the tool said it was already removed.

## What this change does

- After a renewal that is not confirmed, the computer tries again 7.5 seconds later, well before the badge expires, and keeps trying while it still holds it. If it loses the badge anyway, it says so once in the log.
- `instar wakeup` logs in when it asks who is in charge.
- Removing a half-removed computer now finishes the job and keeps the original removal time.

## What stays the same

If renewals keep failing for the whole 60 seconds, the computer still gives up the badge, exactly as before. That safety rule is what stops two computers both thinking they are in charge.
