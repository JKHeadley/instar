# ELI16 — Old queued messages can no longer come back from the dead

## What this actually is

When a message the agent sends you fails to deliver (say, the server was restarting), it goes into a
"try again later" queue. This morning we watched the failure mode that queue makes possible: a fix to
the retry machinery suddenly made it deliver message from JUNE — weeks-old status updates and two
expired secure links — into people's chats as if they were new. Nobody wants a reply to a question
they asked six weeks ago showing up as if it were fresh.

This change puts an expiry check at the exact moment a queued message is about to be picked up for
delivery: if it's older than the allowed age for its queue (24 hours for this one), it is retired —
marked as a dead letter with a written reason — instead of being sent. The operator gets one calm,
batched notice ("N stale queued replies were retired, nothing was sent"), at most once every six
hours, never a flood.

## What already existed vs what's new

Already existed: a cleanup that runs once at server startup, deleting very old queue entries. The gap:
messages that become deliverable LATER — after startup, when some other fix or condition suddenly
unblocks them (exactly what happened this morning) — never met any age check at all. New: the age
check now runs at pick-up time, every time, so there is NO path from the queue to your chat for an
expired message. The startup cleanup stays; this is the belt to its suspenders.

## The safeguards, in plain terms

- It ships OFF. Nothing changes for anyone until it's switched on per-machine, and the test agent
  (Codey) goes first — the same "test → dev → everyone" ladder as every other feature.
- Retired messages are never deleted — each keeps a written record of what it was and why it was
  retired, so anything can be recovered by inspection.
- The age limit lives in a small data file. Setting a queue's limit to 0 turns expiry off for that
  queue without touching code — that's the designed emergency rollback, and the file is protected so
  quietly flipping it to 0 can't happen without an operator-visible trail.
- If the check itself ever fails, it fails toward doing nothing — normal delivery is never blocked by
  a broken guard.
- A message with an unreadable timestamp is treated as fresh, never guessed into the trash.

## What you actually need to decide

Nothing right now — it ships dark. When it arms on the test agent and soaks clean, the promotion to
the dev agent and then the fleet follows the standard maturation ladder, each step reversible.

(Amend note: the two deliberate fail-safe catches carry @silent-fallback-ok annotations for the no-silent-fallbacks ratchet — no behavior change.)
