# Lifeline noise: routine job finishes and "not sure" stop notices — plain-English overview

## What was wrong

The Lifeline topic is the agent's always-on channel to its user. On 2026-11-01
Justin posted a screenshot of it and called the contents noise. Two kinds of
message were filling it.

The first said "3 background sessions were shut down … its work was detected as
complete". The built-in health check runs every five minutes. It is meant to run as
a plain script, but it is still on a review list from the October job-cost change,
so each run starts a full AI session. When that session finishes, the cleanup that
closes it sent a "your session was shut down" message to the Lifeline. That message
was built to warn people when a conversation was cut off. A job with no conversation
that simply finished is not that, so it posted about thirty times in three hours
with nothing to act on.

The second said "A background run stopped mid-task and I couldn't confirm it was a
justified place to stop. Want me to pick it back up?" A checker reviews every time a
session stops. When it is unsure it answers "not sure", and its instructions tell it
to prefer that answer when unsure. That happened on about one stop in nine. Each time,
the message went to the Lifeline without naming the run or saying what it was doing.
Replying in the Lifeline reaches no run, so nobody could act on it.

## What changes

- A background job with no conversation, which ended because its work was finished
  (not mid-work, with no restart queued), is recorded in the reap log only. Every
  other case still notifies as before: a topic's own session, anything cut off
  mid-work, a queued restart, or a session that was stuck or idle.
- A "not sure" from the stop checker is recorded in the logs only.
- When the checker is sure that an unattended run stopped with work left, the user
  is still told. The message now names the run by its goal, quotes the last thing it
  said, and goes to that run's own topic. A reply there reaches the run. If there is
  no named live run to point to, the case is logged only.

## Justin's rule and how it is kept

The notice exists because Justin asked that a session either keeps going or says
why it stopped. That still holds. A run that ends always announces itself in its
own topic. A run the checker can show has stalled is announced in its own topic,
with its name and last message. What is narrowed: "not sure" answers and stalls with
no run to name now go to the logs instead of the Lifeline. Both specs are updated
to say so.

## Safeguards and rollback

Nothing here blocks or kills a session; only whether a message is sent changes.
Everything still lands in the logs (reap-log and sentinel events). Reverting the
change restores the old messages, and the existing config switch still turns the
stop notice off.

## What the reader needs to decide

Nothing. This is a Tier-1 fix that a revert fully undoes. The health check running
as a full session every five minutes is a separate decision, left with the job-cost
review list.
