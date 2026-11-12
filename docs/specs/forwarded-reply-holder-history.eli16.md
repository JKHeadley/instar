# Forwarded replies are saved where they were delivered (plain-English overview)

## What happened

Echo runs on several machines. Only one of them, the "lease holder" (usually the Mac Studio), talks to Telegram directly. When a conversation's session runs on another machine, such as the M5 Pro, its replies are handed to the lease holder, which sends them.

Each machine keeps a log of every message in each topic. Until now, the log entry for a handed-over reply was written only by the machine that wrote the reply, and only if the lease holder clearly answered "sent". Sometimes the answer gets lost on the way back, even though Telegram did receive the message. Then neither machine logged it.

On 2026-11-11 this caused a real stall. The session on the M5 wrote "round 6 is running, a report will follow", but the Studio was out of reach for a moment, so that note waited in a queue. A few minutes later the session asked Justin for a decision. The question reached Telegram, but its answer got lost, so it was never logged. When the queued note was retried, a safety check asked whether anything newer had been sent since. That check reads the logs. The question wasn't in any log, so the check said "no" and sent the old note. It landed right under the question. Justin saw "a report will follow" and waited, and the session waited for his answer, for almost three hours.

## What changes

When the lease holder sends a reply on behalf of another machine, it now writes that reply into its own log too. It records the same plain text the other machine would have logged, with the same Telegram message number.

## Why this fixes it

The safety check already reads every machine's log before releasing a queued note. With the question now logged on the Studio, the check sees a newer message and drops the stale note instead of sending it.

It also fixes a blind spot: the Studio's log used to miss most replies sent from other machines, so anything reading only the Studio's log (bug reports, overseers) could think a busy topic was silent. That is how this bug was first reported.

## Safeguards

- It only writes a log entry. It never sends, retries or blocks anything, and if writing the log fails, the delivery result is unchanged.
- Entries are written only after Telegram confirms the message, using Telegram's own message number.
- When two machines log the same reply, the combined view shows it once, because it already matches entries by message number.

## What you need to decide

Nothing. It is a small change that a revert fully undoes.
