# The watcher now watches the session that is actually answering

## What went wrong

When you message an agent, a watcher starts a timer. If the agent hasn't
replied after about 20 seconds, 2 minutes and 5 minutes, the watcher posts a
short status line, like "still working on it" or, if the session is really
gone, "the session appears to have stopped, reply restart".

On 2026-11-03 Justin messaged Indra in a Slack channel whose old session had
already died. The server did three things in this order:

1. It wrote down his message. That starts the watcher, and the watcher noted
   which session was registered for the channel at that moment: the old, dead
   one.
2. It noticed the old session was dead.
3. It started a new session for the message and registered the new name.

The watcher never looked again. At its 20-second check it saw the old name was
dead, skipped straight to its last stage, and about half a minute in posted
"5-minute check — The session appears to have stopped". Meanwhile the new
session was visibly working on his request. So the alarm was false, and the
"5-minute" label was false too. Telegram restarts follow the same order, so the
same thing could happen there.

## What changes

- **The watcher looks the session up again before every check.** If the
  channel or topic now has a different session registered, it switches to that
  one and carries on with its normal timers.
- **A session that is still starting is not "stopped."** The server now tells
  the watcher when a session is being started for a Slack channel (a small
  counter around the spawn) or a Telegram topic (the registry the server
  already keeps for this). While that is true, the watcher holds the alarm and
  checks again shortly. That hold ends at the 5-minute mark, so a start that
  never finishes still gets reported.
- **One dead reading at the first check is not enough.** If the session reads
  dead at the 20-second check, the watcher waits until the 2-minute mark for a
  replacement before reporting.
  When a held check is finally answered after a later mark has passed,
  the watcher moves on to the stage that matches the time, so the watch
  never quietly ends.
- **Honest labels.** "5-minute check" is printed only when about 5 minutes have
  really passed. A real death found earlier says "Check — The session handling
  this conversation has stopped, and no new session has started for it", with
  no time claim.

## What stays the same

A session that is truly dead with nothing replacing it is still reported, at
about the 2-minute mark instead of half a minute. Every other part of the
watcher (live-work detection, quota and context messages, re-checks, the
one-voice rule between machines) is unchanged. The separate "The session has
stopped" notice from the session monitor (fixed in PR 2601) is not touched.

## What to decide

Nothing. This is a narrow fix, and reverting it brings back the old behaviour
exactly.
