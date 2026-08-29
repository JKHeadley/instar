---
title: Don't throw away a route that's working
slug: mesh-endpoint-degradation-retention
audience: decider
---

# Don't throw away a route that's working

## The one-sentence version

When one of your machines tells the others "here's how to reach me," and its list is
*shorter* than last time, the other machines currently believe the new short list
completely — even when they can see, right that second, that one of the dropped routes
is carrying traffic. This change makes them keep a route they can see working.

## What already exists

Your machines can each be reached several different ways — over Tailscale, over the
local network, or through the Cloudflare tunnel. Each of these is called a "rope."
Every machine periodically announces which ropes it has, and the others write that
list down.

There is already a guard here, and it's a good one: if a machine announces *nothing*,
the others keep what they had. The reasoning was that silence must never erase
knowledge — an older or briefly-confused machine shouldn't be able to wipe out the
routes to itself.

## What was missing

That guard only covers the case of announcing *nothing*. It says nothing about
announcing *less*. If a machine previously announced two ropes and now announces one,
the single-rope list replaces the two-rope list outright, and the missing rope is
forgotten.

That sounds harmless until you meet a machine that genuinely cannot see its own best
address.

On 2026-08-29 exactly that happened. One machine (a Windows box) runs its agent inside
WSL — a small Linux environment nested inside Windows. Tailscale runs on the Windows
side, outside that nested environment. So from where the agent sits, the Tailscale
address does not exist. It can only see one virtual network address, and that address
is unreachable from anywhere except that same Windows machine.

So the machine announced its one useless address. The others obediently replaced the
good Tailscale route — the one that had been carrying every message all day — with the
useless one. The mesh then had no working way to reach that machine, and the machine
had no way to correct the record, because it cannot see the address it needs to give.

## What changes

One rule is added: **a route the machine can currently see working is not discarded
just because an announcement forgot to mention it.**

Concretely, when a machine's new announcement omits a rope that the receiving machine's
own health record says is alive right now, that rope is kept alongside the new list.

Three things it deliberately does *not* do:

- If the announcement *does* mention a rope, the announcement wins — a machine that
  genuinely moved to a new address still updates cleanly.
- If the omitted rope is recorded as dead, it is dropped exactly as before. A route
  that is genuinely retired does not haunt the registry forever.
- If there is no health record at all for that rope — it has never been dialled — it is
  dropped too. No record is not the same as proof; only positive evidence retains.

## The safeguard, in plain terms

The decision is made only on *evidence this machine gathered itself*: its own record of
whether that rope has been working. It never takes the peer's word for it, and it can
never invent a route that was not already known. If the health record can't be read for
any reason, the change does nothing and the old behaviour applies. So the worst case is
"behaves exactly as it did before," and the best case is "stops discarding the only
working route to a machine."

It also cannot cause a stale route to be *used* blindly: the part of the system that
actually chooses which rope to dial already tests ropes and pushes dead ones to the
back. Keeping a record of a rope is not the same as trusting it.

## What you need to decide

Nothing, really — this is a straightforward correction to a guard that only covered
half its case. The judgement call worth knowing about is the one above: retention
requires positive evidence of life, rather than keeping every route forever. That
choice keeps the registry honest at the cost of not helping a machine whose good route
has *also* gone quiet at the moment it announces a shorter list. That case is covered
by the separate, larger piece of work on letting a boxed-in machine be told its own
reachable address.
