# ELI16 — Context-Wall Recovery Escalation

## The problem

You flagged that I'm "still sometimes having trouble recovering from
compaction." I dug into the actual code and logs (not guessing), and here's
what's really going on.

When one of my sessions fills up its memory, Claude Code puts up a wall:
"Context limit reached · /compact or /clear to continue." It's literally asking
someone to press `/compact` (squash the conversation smaller) or `/clear` (wipe
it). The catch I found: **nobody was ever pressing that button for me.** My
recovery system had exactly one move for this situation — kill the session and
start a brand-new one. That works, but it throws away the whole conversation.
And in the logs, it had basically never even fired, because it correctly avoids
touching a session that's still busy working.

So a session could sit stuck at that wall: too busy-looking to safely restart,
but with nothing pressing the button to get it past the wall.

## What this fixes

I added the missing move. Now, before doing anything drastic, recovery tries
the gentle thing first: it presses `/compact` for the stuck session and checks
that the wall actually cleared. If it works, the conversation is preserved —
you don't lose anything, the session just gets lighter and keeps going. Only if
`/compact` genuinely can't help (the conversation is too big to even compact)
does it fall back to the old "start fresh" behavior.

## Why it's safe

- **It won't interrupt working sessions.** The `/compact` press only happens for
  a session that's genuinely idle and stuck at the wall — never one that's still
  actively doing work at 100%.
- **It's strictly gentler than before.** The old behavior (kill + restart) is
  now the LAST resort, not the first and only one.
- **If anything goes wrong pressing the button, nothing breaks** — it just falls
  through to the old path, so it's never worse than today.

Tested both ways: /compact clears the wall → conversation kept, no restart; and
/compact can't help → falls back to a fresh restart. Plus checks that a busy
session is left completely alone.
