# Security warnings reach the owner even without Telegram (ELI16)

## What this is

Instar can let you open a Mac remotely even when it is locked. When that session ends, Instar locks the Mac again. If it cannot confirm the Mac locked again, it has to tell you, because an unlocked Mac sitting open is a security problem. That warning is called a security item, and its title is "A Mac may still be unlocked".

Until now, the only place that warning could go was Telegram. Instar's whole "attention list" (the list of things you need to look at) lives inside the Telegram part of the code. An agent set up without Telegram, which is now a supported setup because the iPhone app has its own conversations, simply printed a line in a log file that nobody reads. The owner was never told.

## What changes

When there is no Telegram, the warning is now written to a small file on the agent's own disk, kept as a list. The normal attention address (`GET /attention`) shows that list instead of answering "Telegram not configured", you can mark an item done the normal way, the iPhone app can show it, and paired phones get a notification. If you do have Telegram, nothing about how attention works changes.

## Safeguards

- Instar only counts the warning as "told" once it is actually saved. If saving fails, it tries again on the next check, so a disk problem cannot silently swallow the warning.
- The list cannot grow forever: it keeps at most 200 rows and never throws away one that is still open.
- One problem is one row. If the same thing happens again, the existing row comes back to the top instead of a new duplicate.

## What you need to decide

Nothing. This closes a gap where a security warning could be lost. It is needed before the planned real-Mac test of the locked-screen feature, which runs on a test agent with no Telegram, and it also protects any real agent that runs without Telegram.
