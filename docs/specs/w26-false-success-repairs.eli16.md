# Two stops that did not stop — in plain English

> The one-line version: two places in the system said "done" when nothing had happened — an
> emergency stop that never killed the session, and an override that was recorded but could not be
> matched to the decision it answered — and both now either do the thing or say plainly that they
> did not.

## The problem in one breath

Window 25 checked each repair where a user would notice it, and found that the failures that
remained all had the same shape: the system reported success while the effect it was reporting
never happened. Two of those were chosen for this window because they sit on control paths a
person relies on — stopping a session in an emergency, and teaching the message check what it got
wrong.

## What already exists

- **The emergency stop.** When you send a stop message, a sentinel recognises it, records that the
  run is stopped so it cannot come back on its own, and is supposed to kill the running session.
  The record half of that already worked and was kept.
- **The tone check and its overrides.** Before one of my messages goes out, a check can hand it
  back with a reason. I may override it with a reason of my own, and the pairing of my override
  with the check's decision is what gets graded — right or wrong — so the check improves over time.
- **The update path.** Scripts installed on an agent's machine are refreshed on update, but only
  when the installed copy matches a version we know we shipped; an unknown copy is left alone.

## What was actually wrong

**The stop.** The code that kills a session looks it up by its internal id. The stop path handed
it the session's *terminal window name* instead. The lookup found nothing and returned false —
quietly. Nobody read that false. The reply to the stop request said "killed", the log said
"killed session", and the person was told "Session terminated." The session kept running.

**The override.** The documented script that sends my replies scrubbed the decision reference to a
safe set of characters — and that set did not include the underscore. A real reference contains
the machine's id, which has an underscore in it. The underscore was stripped, the server could not
match the override to the decision, and the grade landed as an orphan: recorded, useless.

## What this adds

**The kill resolves the right thing and reports what happened.** There is now one helper that turns
a terminal-window name into the session id and kills it, returning the true outcome. Both stop
paths use it, so they cannot drift apart. The reply's "killed" field is that outcome. The log says
"KILL FAILED — the session was NOT killed" when it fails. And the message a person reads comes from
one shared place with three honest states: nothing to stop; stopped; or "stop failed — the session
is still running; your request was recorded; send stop again or close it from the dashboard."

**The reference survives byte-for-byte.** Instead of deleting characters it does not like, the
reply script now checks the reference against the exact shape the router produces (a prefix, an
optional machine id, a UUID) and passes it through whole when it matches — or drops it entirely
when it does not. Hostile input still cannot get through; a real reference is no longer damaged.

**Existing agents get the fix.** The exact version of the reply script that shipped last release
is registered as a known version, so the update replaces it in place instead of leaving a spare
copy beside the broken one.

## The safeguards

- **Tests that fail for the right reason.** Each repair has a must-fail arm that was shown red
  before the fix: passing the window name straight through; answering "killed" for a kill that
  returned false; telling the person "terminated" when it was not; and stripping an underscore
  from a reference. Both sides are tested — a kill that works still reports success, and a
  hostile reference is still rejected.
- **The record is never traded for the kill.** Every failure arm also asserts that the stop record
  was still written.
- **No synthetic history.** The parity test used to reconstruct last release's script from
  today's, which broke the moment the script changed for any other reason. The tempting fix — paste
  the new number in — would have registered a version no agent ever ran. Instead the genuine
  historical script is pinned as a fixture and the test asserts every really-shipped version is
  registered.

## What this deliberately does not do

It does not retry a failed kill; it tells you. It does not guess at a decision reference that
does not fit the shape; it drops it and the integration test will notice if the shape ever
changes. It does not touch a hand-edited reply script on an agent's machine.

## Why it matters

A stop that lies to the operator is worse than a stop that lies to a log: a person acts on it.
And a grade that cannot be matched to its decision teaches nothing, so the check never gets
better. Both repairs are small; the invariant they restore is the window's whole point — a
critical action must not report success unless its effect happened through the documented path.
