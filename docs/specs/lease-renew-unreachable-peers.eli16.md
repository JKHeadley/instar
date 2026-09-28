# One unreachable machine can no longer mute the agent: plain-English overview

## What happened

On 2026-09-27 the agent on the Mac Studio went quiet for about 30 minutes.
Messages from the operator still arrived, but every reply was held back.

The agent runs on several machines. Only one of them may speak at a time. That
machine holds a "lease", a short permission slip that lasts 60 seconds. Every
30 seconds the speaking machine renews the slip, and the renewal counts only
once another machine confirms it. The rule stops two machines from speaking at
once after they lose contact.

One old machine in the list, a Mac Mini last seen on September 15, can never be
reached. The renewal waited for every machine to answer before it counted
anyone. So each renewal waited 30 seconds for the Mac Mini to time out, even
when the other machines had confirmed within a second. The renewal step has a
20-second budget, so it ran out of time on every renewal. When the Studio was
also busy with heavy test runs, the permission slip lapsed and replies were
refused.

## What changed

- A renewal now counts as soon as any one machine confirms it. It no longer
  waits for the slowest one. "One machine is enough" was already the rule, so
  this change only removes the wait.
- A renewal now gives up after at most 8 seconds (at most 40% of the step's
  budget). So the renewal always gets far enough to decide what to do next:
  keep the slip because a peer confirmed, keep it because this is the preferred
  machine and the others are long gone, or let it lapse safely.
- A slow answer still counts. If a machine confirms after the 8 seconds (say at
  10 seconds, which a busy but healthy machine can take), the confirmation is
  kept and the slip is renewed then. Only a confirmation for the current slip
  counts: it cannot bring back a slip that already lapsed or was replaced.
- If another machine answers "I already know of a newer slip" (a signed answer
  that it has seen a higher epoch), this machine stops speaking right away and
  fetches that newer slip. Before, that answer was checked and then ignored.

## What did not change

- The safety rules that stop two machines speaking at once are untouched. A
  machine that is unreachable but was alive recently still makes the speaking
  machine step down after 60 seconds. That is on purpose: that machine might
  be about to take over.
- A machine that took over with a newer permission slip still wins.
- Holding the slip never increases its number (the epoch).

## Safeguards, in plain terms

One confirmation proves this machine reached one other machine. It does not prove
no other machine thinks it may speak: if the machines split into two groups that
cannot see each other, each group can hold its own view until they reconnect.
That limit already existed and this change does not alter it.

The tests prove both sides. When peers answer, or all of them are long gone,
the preferred machine keeps sending. When a peer is unreachable but recently
alive, sending is still held. The tests also show that the old code muted
exactly the cases it should have kept speaking in.

## One part not fixed here

A second check can also hold replies when the machine is overloaded. It checks
whether the display settings are fresh. It fails closed on purpose when the
settings cannot be read within 2 seconds. Whether it should keep the last good
settings through a short overload is its own safety question. It is tracked as
a separate commitment with a deadline. <!-- tracked: CMT-610 -->

> **CMT-610** — "I will assess whether the origin display snapshot should tolerate a starved event loop (keep the last good snapshot through a transient config-read deadline, bounded) without weakening its fail-closed config-change guarantee, and ship a fix or a written ruling."

## A note on one check

A code scanner counts places that quietly swallow errors. The renewal already
treated a failed send as "not confirmed", which is the safe direction. That line
is now labeled so the scanner knows it is deliberate.

## Who decides what

Nothing new is asked of anyone. No settings change; the deadline is derived
from the existing tick timeout.
