# Agent-Signature Provenance — Plain-English Overview

> The one-line version: agents can now sign what they write, so the system can
> tell your words from an agent's even when both arrive from your account — and a
> copied or altered message is refused rather than believed.

## The problem in one breath

When an agent sends a message through your Telegram account, it arrives looking
exactly like something you typed. Nothing downstream can tell the difference. In
one topic, a prior measurement found roughly **46% of messages that looked like
the operator's were actually written by an agent** — so any reader, human or
machine, that treats "came from his account" as "he said it" is wrong about
nearly half that traffic.

In the operator's own words, what was wanted is *"some official signature that
agents/topics can send within messages that the infra can detect to recognize
messages that are NOT me, even though they come from my account."*

## What already exists

- **The account itself** — proves which *account* sent something. It cannot
  distinguish which *mind* composed it, because agents legitimately send through
  the operator's account.
- **A style-based authorship guess** — flags messages that *look* agent-written
  from their phrasing and context. Useful, and genuinely cannot do the job alone:
  see below.
- **Agent identities** — every agent already holds a cryptographic keypair used
  for agent-to-agent messaging. This work reuses that existing identity rather
  than inventing a second one.

## What this adds

An agent can attach a short signed tag to a message. The signature covers the
agent's name, the topic, the time, a one-time marker, and a fingerprint of the
message text — so changing *any* of those breaks it. On the way back in, every
message is sorted into exactly one of three buckets: **yours** (no tag),
**that agent's** (valid tag, named), or **refused** (a tag that doesn't hold up).

Secondary changes: refusals are recorded with their reason; the "one-time marker"
state survives restarts; and other agents' keys can be resolved so this works for
more than just self.

**Why a signature rather than better guessing.** A style-based detector cannot
refuse an exact copy. If someone re-sends a genuine agent message word for word,
every stylistic signal says "genuine" — because the text *is* genuine. The only
thing that separates the original from the copy is a marker that can be used once.
That is the whole reason this layer is cryptographic. It doesn't replace the
style-based guess; it upgrades a *suspicion* into a *proof* for messages that
carry a signature, and the guess still covers everything unsigned.

## The new pieces

- **The signer/verifier** — makes and checks the tag. It answers exactly one
  question: *who wrote these bytes?* It is deliberately incapable of answering
  *what may they do?* — there is no permission or trust field anywhere in its
  answer.
- **The one-time-marker store** — remembers which markers have been used, on
  disk, so a restart doesn't wipe the protection. If that file is ever damaged it
  refuses to start rather than quietly starting empty, because an empty store
  would accept every replay.
- **The inbound recorder** — classifies each arriving message and writes down the
  verdict. It can never block, delay, or drop a message; every failure inside it
  is counted and swallowed on purpose.
- **The key directory** — finds the right key for another agent, and reports *how
  much that key is worth*: our own, human-verified, or merely learned from local
  discovery. Those are not the same thing and the code refuses to let them blur.

## The safeguards

**Prevents someone forging an agent label.** A made-up tag has no valid
signature, so it is refused. Knowing the format exactly doesn't help — the format
was never the secret.

**Prevents a real message being edited.** The signature covers a fingerprint of
the text, so altering a single character invalidates it. Adding text *after* a
genuine tag makes the message read as yours rather than the agent's — attribution
is lost rather than misapplied, which is the safe direction.

**Prevents a genuine message being re-sent.** Each signature carries a marker
usable once, plus a freshness window. A word-perfect copy is refused as a replay.

**Prevents the system minting messages in an agent's name.** There is
deliberately no "sign this for me" endpoint. One would let anyone with server
access forge agent messages — exactly the attack this exists to stop.

**Keeps identity separate from permission.** A valid signature proves who wrote
something. It never establishes what they are allowed to decide. Anything that
treats "signed by agent X" as authorization is a defect, and the answer's shape
gives it nothing to lean on.

## What you actually need to decide

Nothing about the mechanism itself — it is off in the sense that nothing signs
automatically, so no existing message changes meaning. The decisions that remain
are whether to turn on automatic signing for outbound agent messages later, and
whether an unsigned agent message should eventually be treated as suspicious
rather than neutral. Both are deliberately left open.

## What ships when

The signer/verifier, the durable marker store, the inbound recorder, the key
directory, and the two read-only endpoints ship together — they are one
mechanism and a partial version would report guarantees it doesn't have.
Automatic outbound signing does **not** ship here; agents must sign explicitly,
so nothing starts changing the look of existing traffic on its own.
