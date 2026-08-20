# The relay said "sent" for messages nobody received — Plain-English Overview

> The one-line version: when the server quietly drops a repeated message, the script that sends it used to report success anyway, so the agent believed it had answered when the user had heard nothing.

## The problem in one breath

Your agent has a duplicate guard: if it tries to send the exact same text to the
same conversation twice in a short window, the server drops the second copy so you
don't get spammed. That part is working as intended. The bug is what the agent was
told afterwards. The server replies "OK" — and includes a note in the reply saying
*"I suppressed that one, it was a duplicate."* The little script that does the
sending read only the "OK" and threw the note away. It then printed `Sent 412 chars`
and reported success.

So the agent ticked the task off and moved on, genuinely believing it had replied
to you. From your side, nothing arrived. There was no error, no warning, and no
record anywhere that the agent could later check. The failure was completely
silent, and it was silent in the worst possible direction: the agent was confident.

## What already exists

- **The duplicate guard** — lives in the server. It decides what counts as a
  repeat and drops it. This is unchanged; it was never the broken part.
- **The reply script** — a small shell script on every agent's disk that actually
  performs the send. It already knows how to report several other outcomes
  honestly: a timeout, an ambiguous transport failure, a blocked message. The
  suppressed-duplicate case was simply missing from that list.
- **The update migrator** — the thing that upgrades files on agents that already
  exist. Instar agents update in place, so shipping a new file into the source code
  is not enough on its own; the migrator is what actually puts it on their disks.

## What this adds

**The script now reads the note it was already being sent.** If the server says the
message was suppressed, the script prints `NOT SENT — suppressed duplicate for
topic 12345; an identical message was already delivered to that topic recently`
and exits with a failure status instead of a success one. That failure status is
the part that matters most, because it is the signal most callers actually check.

The second half is less visible and more important:

- **Existing agents actually receive the fix.** The migrator identifies deployed
  copies of the script by their exact fingerprint, and only upgrades ones it
  recognises as genuinely shipped by us. The fingerprint of the current (broken)
  version had to be registered, or the migrator would treat every agent in the
  field as "someone edited this, leave it alone", drop a `.new` file beside it, and
  every existing agent would keep the lying script forever. This registration is
  the real deliverable — the seven-line script change is inert without it.
- **Tests at all three levels**, including one that stands up a fake pre-existing
  agent, confirms it has the bug, runs the real update, and then runs that agent's
  own upgraded script to prove it now tells the truth.

## The new pieces

- **The suppression branch** — seven lines inside the existing "the server said OK"
  path. It is allowed to *report* an outcome. It is deliberately NOT allowed to
  decide anything: it cannot cause a send, prevent one, or retry one. The server
  had already made the decision and already written it down; the only bug was that
  nobody read it. Keeping this line sharp matters, because a piece of code that
  merely reports can be simple and cheap, whereas anything that *decides* has to be
  much more careful about being wrong.

## The safeguards

**Prevents a false "not sent" from ever appearing.** The reverse mistake would be
worse than the original bug: if the script wrongly claimed a delivered message had
been suppressed, the agent would send it to you a second time. So the check is
strict rather than generous. It requires the value to be exactly the boolean
`true`; the *word* "true" as text does not count. If the reply is unreadable, if
the field is missing, or if the tool used to read it isn't installed, the script
falls back to its old behaviour rather than guessing. Every uncertain case resolves
toward the way things worked before, never toward a false alarm.

**Prevents the fix from quietly reaching nobody.** This is the failure this project
has hit before: a change lands in the source code, every test passes, and not one
agent in the field ever receives it. The test suite now fails if the fingerprint
registration is missing, so "shipped" and "actually delivered to existing agents"
cannot drift apart silently.

**Prevents anyone's customised script from being overwritten.** If an operator has
hand-edited their own copy, the migrator leaves it exactly where it is, writes the
new version alongside as a `.new` file, and raises a notice so a human can merge
the two. Being helpful never justifies stomping on someone's work.

**Prevents it from disturbing anything else.** The new branch sits inside the
existing "OK" path only, so the timeout path, the ambiguous-transport path and the
blocked-message path all behave exactly as they did. A test pins each of those.

## What ships when

All of it ships together, in one change: the script fix, the registration that
delivers it to existing agents, and the three tiers of tests. Splitting them would
be worse than useless — the script fix alone reaches only newly created agents,
which is precisely the gap this closes.

Rolling it back is a plain revert with no data to clean up. One honest wrinkle
worth knowing: agents that already updated would keep the fixed script after a
revert, since the migrator would no longer recognise it and would leave it in
place. That is the safe direction — a rollback stops new agents from getting the
fix, but does not push anyone back to being told their unsent messages were sent.
