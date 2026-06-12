# Durable Inbound Message Queue — Plain-English Overview

## The problem, in one story

You send me a message on Telegram. Behind the scenes, a router decides which of your
machines should handle it. Usually that's instant. But sometimes the answer is "not
right now" — the conversation is mid-move between machines, or the machine that owns it
is having a 5-second network hiccup.

Today, the router's answer to "not right now" is wrong in a quieter way than we first
thought: there's a function in the code literally called `queueMessage` — wired to
*nothing* — and when it fires, the message just gets handed to whatever copy of the
conversation THIS machine happens to have, immediately, even if this machine isn't the
right one. The June 5th audit found this and we put it on the roadmap; this is that
work. (The review round on this very spec sharpened the diagnosis: an earlier draft
described the failure as "hot replay"; the reviewers proved against the shipped code
that the real failure is wrong-place delivery.)

That causes three real problems:

1. **Wrong-place delivery.** A message for a conversation that's mid-move between
   machines gets injected into the old, stale copy — which may be about to be closed.
   The work happens in the wrong place or dies with the closing session.
2. **Lost messages.** Some message paths have no safety net at all: a crash at the
   wrong moment and the message is just *gone*, and nothing even records that it
   existed.
3. **Pointless machine-swapping.** Because there's nowhere to put a message and wait,
   the router's only option when a machine looks shaky is to immediately move the whole
   conversation to another machine. A 5-second blip causes a full house-move. You asked
   us to stop swapping machines so much — this is why it happens.

## What we're building

**A real queue.** When the router can't deliver a message right now, it writes it into
a small on-disk database (the same battle-tested pattern we already use for outgoing
Telegram messages), along with who sent it, so a later delivery still knows its real
sender. The message is now *safe on this machine*: a crash, a restart, or a slow
machine can't lose it. The moment the blockage clears — the move finishes, the machine
answers — the queue delivers everything, in the right order, once. One honest limit:
the queue lives on one machine's disk. If that machine dies *permanently* while
holding messages, those are lost — but never silently: the surviving machines see its
last "I'm holding N messages" heartbeat and tell you what went down with the ship.

**A "hold still" policy.** With a safe place to put messages, the router gets a better
option for shaky machines: *wait briefly instead of moving house.* If a machine is
blipping but its heartbeat is still alive, its messages wait in the queue for up to 90
seconds. Machine recovers (the usual case) → messages deliver right there, no swap.
Machine stays bad past 90 seconds → conversation moves, exactly like today, just 90
seconds later. Dead machines (no heartbeat at all) still fail over immediately — the
hold only applies to "slow," never "gone."

## The brakes (because the cure must not become the disease)

Everything that repeats in this design carries the three mandatory brakes from the
"No Unbounded Loops" rule you ratified: waits get longer between retries, a breaker
stops futile attempts, and hard caps bound everything. The queue itself is capped (50
messages per conversation, 500 total, 30-minute shelf life) so it can never silently
grow into a monster. And when a message *does* expire or get evicted, it is never
silent — you get one tidy notice naming what was lost, never a flood.

## What ten rounds of review did to this design

This spec went through the deepest review gauntlet we've ever run: ten rounds, six
internal reviewer angles plus GPT and Gemini as outside readers, roughly 270 findings
total. The core design — a small on-disk queue plus a "hold still" policy — survived
unchanged from round 2. What the rounds actually fixed was the *edges*: a counter
that would have wrongly expired nearly every queued message within 2 minutes (the
multi-machine system renews its "who's in charge" badge every few seconds, and my
draft confused renewals with real changes of control); a crash window where a message
could be recorded as "delivered" while being silently lost (now always reported
honestly, with enough breadcrumbs to know what to resend); an emergency-stop command
that could still let one message slip through (closed with a database-level fence);
and a pause command that could collide with its own safety machinery (fixed by making
pause let in-flight work finish — a pause is a hold, not an abort). The final rounds
pinned every "this number must be bigger than that number" rule into one boot-time
check that refuses to run the queue half-configured, ever.

## What changes for you

Nothing, until we turn it on — it ships dark, then goes through dry-run on the dev
agents first, like everything else. Once live: fewer "machine moved for no reason"
moments, no more hot-replay loops during conversation moves, and a guarantee that a
message I've accepted is a message that gets handled — or you get told. The main
tradeoff is honest: on a genuinely flaky machine, replies can arrive up to ~90 seconds
later than today's instant-swap behavior. We chose "a bit slower during blips" over
"constant house-moving," which is exactly the trade you asked for.

*(Spec approved by Justin 2026-06-12; built the same day — see `upgrades/side-effects/durable-inbound-message-queue.md` for the build-time side-effects review.)*
