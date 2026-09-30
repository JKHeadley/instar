# A session that worked for hours after a restart is restarted again when its age limit ends it: plain-English overview

## What happened

The server keeps a restart queue. When it ends a session that was in the
middle of something, the queue can bring that session back with its
conversation. To stop a session that keeps dying from being restarted
forever, the queue has a brake: after two restarts of the same topic within
24 hours, it refuses the next one and raises one loud notice.

On 2026-09-30 the Instar 2.0 coordinating session (topic 52075) was ended
three times:

- 10:57 UTC and 12:51 UTC: ended to free resources while idle. Both times it
  had unfinished changes in its folder, and both times the queue restarted it.
- After the 12:52 restart it worked for more than five hours: posting status
  updates, starting builds and reviews.
- At 18:02 it finished a turn and waited at its prompt. It had passed its
  four-hour age limit. At 18:14, after twelve quiet minutes, the age limit
  ended it. It still had unfinished changes, so it was a valid restart case.

The queue refused it anyway: this was the third end in 24 hours, so the brake
treated it as a session that keeps dying. It stayed down for 37 minutes until
someone woke it by hand.

The age limit itself behaved as designed. Its protection keeps a session
alive while it is working and for ten minutes after it was last seen working.
At 18:14 the session had been idle at its prompt for twelve minutes, with
nothing running in its own window (its builds run in other sessions).

## What changed

When the age limit ends a session, the server now notes whether it saw that
session working after the session passed its age limit. A session like that
lived its whole allowed lifetime and was doing real work late in it. That is
the opposite of a session that keeps dying, so the restart queue starts its
count for that topic again from zero and queues the restart.

## What did not change

- Which sessions the age limit ends, and when.
- A session with no evidence of unfinished work is still not restarted.
- A session that is restarted and then quickly ended again, over and over,
  is still stopped by the brake after two restarts in 24 hours. The count
  just restarts after a session proves it lived and worked a full lifetime.
- Operator stops are still never restarted automatically.

## What to decide

Nothing. This is a bug fix inside existing limits. The count can restart at
most once per age-limit lifetime of a session (four hours by default), and
only after that session did real work past its age limit. Between restarts
of the count, the usual limit of two restarts applies.
