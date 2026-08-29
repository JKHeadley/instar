---
title: How does a machine prove something about itself that it can't see?
slug: machine-self-assertion
audience: decider
---

# How does a machine prove something about itself that it can't see?

## The one-sentence version

Twice in one week a machine needed to tell the others something true about itself —
"here's my new key", "here's the address that actually reaches me" — and had no way to
prove it; this design lets the mesh accept the truth automatically when the evidence backs
it, and asks you for one tap only when the evidence can't tell recovery from takeover.

## The two things that happened

**The lost key.** The Studio's identity files went missing on the 27th. Its keys were
regenerated. The other machines still held the old key, so every message the Studio sent
was rejected as forged — nearly eleven thousand rejections per connection — and the mesh
ran one-way for two days. Fixing it took a human writing files onto each machine by hand.

**The invisible address.** One machine runs its agent inside WSL, a Linux box nested
inside Windows. The address everyone reaches it on belongs to the Windows side, which the
agent literally cannot see. So it announces an address that works from nowhere, and can
never announce the right one.

## Why "just let it announce itself" was rejected

Your directive was the least human effort possible, and the first draft said: fully
automatic — a machine announces its new key, proves it holds that key, done. Eight
independent reviews (including two non-Anthropic models) all found the same hole: *anyone*
who just created a key can prove they hold it. That proof filters out nobody. Combined
with the shared machine password, a fully automatic accept would mean anyone who stole
that password could become one of your machines — and the only trace would be one
notification into a queue that provably buried the last critical alert for two days.

## The design that keeps it zero-touch anyway

The trick is that a *real* recovery leaves evidence an impostor can't fake, and the mesh
already holds it:

- The recovering machine has a **local rotation record** — a timestamped "my keys were
  regenerated, here's why" note that survives in its replicated public metadata.
- The other machines have **first-hand evidence** — they themselves have been refusing
  that machine's messages (they can see their own "invalid signature" log).
- The announcement **arrives from an address the peers already know** for that machine.

When all of that lines up — which is what an actual lost-key recovery looks like — the new
key is accepted automatically. No tap, no approval. The incident from the 27th would have
healed itself in minutes.

When it *doesn't* line up — the claim comes from an address nobody recognizes, or there's
no rotation record, or two different claimants are fighting over the same machine — the
claim is parked, nothing is stored, and you get one approve/deny button on your dashboard.
That's the only moment a human is ever involved, and it's precisely the moment where
"automatic" would mean "automatic for the attacker too."

Every identity change also lands in a permanent ledger that keeps resurfacing until you
acknowledge it — so even a change you didn't approve can't slip past unseen, no matter how
noisy the notification queue is that day.

## The address half

For the machine that can't see its own address, the answer needs no trust at all: the
other machines record where its *authenticated* traffic actually comes from, confirm it
over half an hour, dial it back to make sure it really answers as that machine, and only
then use it — and never in place of an address that's already working. Fully automatic,
because it's built on what the observers can verify themselves, not on what the boxed-in
machine claims.

## Safety rails, briefly

Announcements carry a strictly increasing generation number, so an old captured
announcement can never be replayed and two rotations can't fight. One machine gets at most
one automatic re-key a day, three per key generation — then it must go through you.
Everything ships switched off for the fleet and in rehearsal mode on the dev machines
first, and the file-editing hole that made all this possible gets closed in the very same
change that opens the proper door.

## What you need to decide

Nothing new — this is your least-human-effort directive, made survivable: zero taps for
every legitimate case, one tap reserved for the case where the evidence itself says
"this could be theft."
