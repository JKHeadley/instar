# A send held for a lapsed lease renewal is retried within seconds, named, logged and counted — Plain-English Overview

> The one-line version: when the lead computer refuses one of its own Telegram sends because its lease renewal ran a
> few seconds late, the reply should go out seconds later, the log should say what happened, and the delay should be
> counted — without ever letting a computer that has really lost the lead send anything.

## The problem in one breath

Echo runs on several computers, and only one of them, the lead, is allowed to talk to Telegram. The lead keeps that
right by renewing a short pass (a lease) every 30 seconds; the pass is good for 60 seconds. If the lead's own server
freezes for a few seconds at the wrong moment, it can briefly believe its pass has run out, even though no other
computer took the lead. In that moment it refuses its own sends. On 2026-11-21 eight sends were refused this way or
another: the refusals were all filed under the one name reserved for "sending too fast", so the records cannot say
which cause it was, nothing was written to the log, and the held replies went out minutes later instead of seconds
later. The lead's own late renewal is the likely cause, and this change is what makes the next one measurable.

## What already exists

- **The lease** — the record of which computer is the lead, renewed every 30 seconds, valid for 60 seconds. A
  computer that cannot confirm a renewal inside 60 seconds stops acting as the lead. This is the safety fence that
  stops two computers from both talking to the user, and it is correct.
- **The send permit** — one small in-memory authority on the lead that gives each outgoing Telegram request a brief
  permission to start. It refuses when the computer is not the lead, when it has just started, when the account is
  unknown, or when more than ten sends tried to start inside about a second. Today every refusal carries the same
  name, `credential-capacity-unavailable`.
- **The outbox and its recovery pass** — every reply is written down before it is sent; a refused reply is kept and a
  background pass, run every 30 seconds, tries again. Each try pushes the next one further out (30 s, 1 min, 2 min,
  5 min, then 15 min) whether or not the lead is back.
- **Never-silent incidents** — a record of every conversation that is waiting on an answer and why, readable from the
  agent's own status page. It knows about engine logins, usage limits and crashed sessions; it does not yet know
  about a reply held at the moment of sending.

## What this adds

The biggest change is speed: a reply held because the lead's renewal lapsed is tried again 2 seconds later, then 5,
10 and 30 seconds, but only once the computer holds the lead again. The retry never sends anything by itself; it
only wakes the existing recovery pass, which runs every one of today's checks again.

- The refusal gets a name that says what was seen: `lease-freshness-lapsed` when the lease code itself says its
  renewal ran past the lifetime, `lease-not-held-at-send` when the lead was lost some other way (another computer
  took it) or nothing could be measured. The outbox, the status page and the owner's "did my message go out?" check
  all say the same thing. The old name stays for the other refusal causes and is still accepted everywhere it is
  matched today.
- One log line per refusal states which check refused, how long it had been since the last confirmed renewal and the
  lifetime. It carries no token, no chat id and no message text.
- Each such hold is counted in the never-silent record (a list beside its incidents), closed when the reply finally
  goes out, with the delivery time, so the cost of these lapses can be read later instead of guessed.
- The "a reply needs delivery attention" message that today fires the instant a reply is held no longer fires for a
  lease hold. If the four retry steps end and the lead is still not back, the existing channels take over: the
  five-minute delivery check puts a dashboard item up for a reply that is still waiting, and a reply still unsent
  after 30 minutes is handed back to its author as today. The conversation never gets a stale warning about a blip
  that already cleared.

## The safeguards

**The fence stays.** No reply leaves a computer whose lease check says "not the lead". The retry asks "is the lead
back?" and, only on yes, runs the same gates as before. A refusal while the lead is really gone is still a refusal.

**No runaway loops.** One timer per episode, four steps, then it stops and the regular 30-second pass takes over.
At most four of these extra passes run per lease lifetime, however often the lead flaps. The pass is single-flight;
a wake that arrives while a pass is already running waits for it to finish and then runs one more, so no held reply
is left for the slow path because a pass had already picked its batch.

**No wasted ladder steps.** While the lead is away, the recovery pass skips these held replies without reserving a
try, so the back-off ladder no longer climbs for attempts that were certain to fail.

**The count is a count, not an alarm.** A send hold is never shown to the judge that diagnoses silent sessions,
never produces a notice to the user and never triggers an engine swap. If never-silent is switched off, nothing is
recorded there and the log line is the record.

## What ships when

One pull request, one release: the naming and log line, the short retry, the incident count and their unit tests.
Nothing is switched on or off by configuration; the behavior applies on every computer that holds the lead.

## What you actually need to decide

Nothing beyond agreeing that a few-second retry gated on holding the lead is the right shape; the fence, the cap
and every existing gate are untouched.
