# An age-limit kill now records unfinished work, so the session comes back: plain-English overview

## What happened

Every session has an age limit. Once a session is past it and has done
nothing for at least ten minutes, the server ends it.

On 2026-09-29 at 18:52 PDT this happened to the Instar 2.0 coordinating
session (topic 52075). Looking back through the logs and its transcript:

- At 18:28 it had a command running in the background, so the server left it
  alone.
- That command finished at 18:38. At 18:40 the session finished its turn. It
  had also cleared its own old, expired goal.
- By 18:52 nothing had run for twelve minutes, so the server ended it.

The server judged the session correctly both times: busy at 18:28 and idle at
18:52. The real problem is what came after. The server keeps a queue of
sessions to restart. A session gets in only when there is evidence it was in
the middle of something. The session had unfinished, uncommitted changes in
its folder. The idle clean-up already checks for those and records them, and
that brought this same session back the day before. The age-limit clean-up
did not check, so the session was recorded as "not mid-work" and left off
the queue.

## What changed

Before ending a session for age, the server now does the same uncommitted-work
check the idle clean-up does. If the folder has unfinished changes, the kill
is recorded as mid-work. The restart queue can then bring the session back
with its conversation, under the same limits it always uses (at most twice a
day per topic, among others).

## Also fixed: an active goal really is protected now

A session with an active autonomous run or goal is supposed to be left alone.
The check behind that only looked at whether the run's file had been written
in the last 30 minutes. A run that sat waiting for more than 30 minutes looked
finished, and the session could be ended for age. Now the check reads the run
itself: while the run is switched on and its time window has not ended, the
session is kept, however old the file is. A run that is switched off, paused,
or past its window no longer keeps the session.

## What did not change

- When sessions are ended. The age limit ends exactly the same sessions at
  the same moments.
- A session with a running background command is still left alone.
- A session with no running work and a clean folder is still ended and not
  restarted automatically. (On this agent, sessions work in its home folder,
  and that folder nearly always has some unfinished changes. So in practice
  a session ended for age here now comes back, at most twice a day per
  topic, just as sessions ended for being idle already do. Agents without
  this feature switched on see no change.) Its conversation is saved, and the next message
  in its topic brings it back.
