# Ownership Follows Live Work — the ELI16 version

## The setup (same world as PR #1258)

I'm one agent running on more than one of Justin's computers — say the Laptop and
the Mac Mini. A "topic" is one conversation (one Telegram thread). At any moment
that conversation should be served by exactly ONE machine, and the others should
NOT keep a worker running for it (a leftover worker does duplicate work, or worse,
answers the same person twice).

To track "who serves this topic right now," there's an **ownership record** per
topic. It's like a name tag that says "the Mini owns topic 42." Machines read that
tag to decide whether to do work or stay out of the way.

## What the LAST fix did, and what it left undone

The previous fix (PR #1258) noticed a scary bug: the janitor inside the reaper was
KILLING the one live worker for a topic because the ownership tag was **stale** —
it said "the Mini owns this" when the Mini actually had no worker for it, and the
Laptop's worker (the real one) got killed.

PR #1258 made the janitor **double-check before killing** ("does the machine on the
tag actually have a live worker? if not, don't kill"). That stopped the harm. But
it's a band-aid: it defends against a lying tag instead of fixing why the tag lies.

**This spec fixes why the tag lies.** Three small leaks let the tag drift away from
where the work actually is:

## The three leaks (and the three plugs)

**Leak A — nobody updates the tag when a session FINISHES.** When a conversation's
worker finishes its job, nothing changes the ownership tag. So if a topic was moved
to the Laptop and the Laptop's worker then finishes, the tag still says "Laptop
owns it" forever — a stale tag, exactly the kind PR #1258 has to defend against.

**Plug A — release on complete.** The instant a worker finishes, if this machine is
the one on the tag, it clears the tag ("released — nobody's serving this now"). Now
there's no stale "active" tag to mislead anyone. This is the real fix PR #1258
deferred: with the tag cleared on finish, the janitor never even considers a kill.

**Leak B — an "autonomous" worker grabs no tag.** Some workers (long autonomous
runs, keyed by topic) get started directly, skipping the normal routing that
stamps the ownership tag. So a machine can be doing the real work for a topic while
the tag still points at a different machine.

**Plug B — claim on spawn.** When an autonomous worker spawns on a machine, that
machine stamps the tag for itself ("I'm serving this now"). Now the tag follows the
live work. (Carefully: it only claims an *unowned* topic. If another machine
genuinely owns it, it does NOT steal it — stealing a live worker is reserved for a
special "the owner is provably dead" path, never an ordinary spawn.)

**Leak D — recovery re-runs a topic it no longer owns.** When a worker gets stuck
or hits a memory wall, a recovery path restarts it and re-feeds the last message.
But that path never checks the ownership tag — so if the topic already moved to
another machine, the recovery restarts the LEFTOVER worker here AND the message
also gets served on the owner machine = the user gets answered twice.

**Plug D — check ownership before recovering.** Before a recovery path restarts a
worker, it reads the tag:
- Tag says "me" (or nobody) → recover here, like today.
- Tag says "another machine, and it's reachable" → don't restart here; hand the
  message to the owner instead. No double-reply.
- Tag says "another machine, but it's offline right now" → DON'T restart here
  either (that's the double-dispatch trap), but the message isn't lost — it waits
  in the durable queue and gets served once the owner comes back.

## Why it's safe

- **The tag is authority, so every change goes through the same locked door.** A
  release or a claim runs through the exact same fenced state-machine the rest of
  the system uses — each change bumps a version number, and a change that arrives
  "too late" (someone already moved the tag) simply loses and does nothing. You can
  never stomp a newer truth with a stale one.
- **Every uncertain case fails toward the safe direction** — but the safe direction
  is different per leak: for releasing/claiming, "when unsure, don't touch the tag";
  for recovery, "when another reachable machine owns it, don't double-reply; when
  nobody owns it, do recover so the conversation isn't stranded."
- **It all hides behind a switch that defaults OFF on the fleet and ON only for the
  dev machine to dogfood.** With the switch off, everything behaves exactly like
  today. The dev pair runs it live first; the fleet flip happens only after a real
  multi-machine soak proves it.

## How this closes the loop with PR #1258

PR #1258's double-check exists ONLY because a finished-but-not-released tag can lie.
Plug A makes the tag clear itself on finish, so that lie can't happen anymore. Once
Plugs A and B have soaked on the dev machine, PR #1258's band-aid (the extra
liveness double-check) can be retired — the tag is trustworthy on its own again.
That retirement is registered as a tracked follow-up so it isn't forgotten.

## What this spec deliberately does NOT do

The fully race-free end-state — machines *announcing* "I started/stopped serving
this" over a live channel, or tags that auto-expire on a timer — is real but
separate. This spec makes the tag follow the work via explicit release/claim/gate;
the push-based version is a later, bigger change with its own delivery guarantees.
It also does NOT touch the reaper janitor itself — PR #1258 owns that.
