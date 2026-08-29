---
title: How does a machine prove something about itself that it can't see?
slug: machine-self-assertion
audience: decider
---

# How does a machine prove something about itself that it can't see?

## The one-sentence version

Twice this week a machine needed to tell the others something true about itself — "here's
my new key", "here's the address that actually reaches me" — and had no way to prove it,
because the proof was either lost or invisible from where it stands.

## The two things that happened

**The lost key.** The Studio's identity files went missing on the 27th. Its keys were
regenerated. The other three machines still held the old key, so every message the Studio
sent them was rejected as forged. Messages *to* the Studio kept working, so the mesh ran
one-way for two days without anything stopping.

Fixing it meant a human reaching into each machine's filesystem. There is no built-in way
to do it, and there's a reason: the normal way a machine introduces itself requires a
pairing code issued by the trusted machine — but here the machine needing to re-introduce
itself is exactly the one nobody trusts any more.

**The invisible address.** One machine runs its agent inside WSL, a Linux environment
nested inside Windows. The address everyone actually reaches it on belongs to the Windows
side, outside that nested box. From where the agent sits, that address does not exist. So
it announces the only address it can see — one that works from nowhere — and it can never
announce the right one.

Both are the same problem wearing different clothes: **state a fact about yourself that
you cannot back up.**

## The tempting fix, and what it costs

The machines already share a password-like token for talking to each other. That token is
what I used by hand to repair the key. So the obvious move is to let a machine simply
re-announce itself using that token.

Here's the catch, and it's the whole reason this is a decision rather than a fix.

Right now, if that token leaked, someone could read and change a lot — but they could
**not** pretend to be one of your machines. Machine identity is protected by keys the
token has no power over. Two separate locks.

Allowing re-announcement over the token merges those two locks into one. A leaked token
would then be enough to impersonate a machine, or to redirect one machine's traffic to an
address of the attacker's choosing.

That may still be worth it. But it should be your call, made knowing that's the trade —
not something I quietly implement because it was convenient.

## What I'd suggest

**Two of the three pieces don't need that trade at all.**

First, a straightforward bug fix. When a machine is refusing another's messages, it
currently gets filed as "that machine is probably asleep" — because the heartbeat stopped.
But the heartbeat stopped *because of the refusal*. It's reading its own symptom as the
innocent explanation. A machine that actively answers "no, I don't believe you" is
demonstrably awake, and should be reported as a problem, loudly. This needs no new powers.

Second, for the address problem, there's a nicer answer than letting a machine claim an
address. The other machines already *know* the working address — they're connecting to it
successfully every minute. Instead of trusting a claim, let them record what they
observed. That's first-hand evidence rather than an assertion, and it adds no new risk.

That leaves only the key case genuinely needing your decision. My suggestion there is a
middle path: the machine can ask to re-announce itself, but it takes one tap from you on
your dashboard, protected by your PIN. Your PIN is something the token doesn't grant, so a
leaked token still can't impersonate anything on its own. The cost to you is one tap, and
only when a key is actually lost — which has happened once in the mesh's lifetime.

## What you actually need to decide

Just this: **is one PIN-protected tap an acceptable price for making a lost key
self-repairable, given it means your PIN becomes the thing standing between a leaked token
and a machine impersonation?**

If you'd rather not, the fallback is honest and still much better than what happened: I
detect the breakage within minutes and tell you loudly, and you or I repair it by hand.
Nothing silently runs one-way for two days again either way.
