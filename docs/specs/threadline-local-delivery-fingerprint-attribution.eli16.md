# Threadline local-delivery fingerprint attribution — Plain-English Overview

> The one-line version: when an agent on the *same computer* replies to you, work out the sender's permanent ID (their fingerprint) the exact same way the conversation was filed, and hand only that one fact to the anti-hijack guard — so it stops mistaking a real reply for an intruder and throwing it away.

## The problem in one breath

Echo messaged the Luna agent (same Mac); Luna replied — and the reply vanished. A guard that protects conversations from hijacking saw Luna's reply coming from "sagemind" (her *name*), but the conversation was filed under her *fingerprint* (`1db85f`). Name ≠ fingerprint, so the guard assumed an intruder and quarantined the reply into a new empty thread. Same agent, two ways of writing her identity, never reconciled.

## What already exists

- **The anti-hijack guard** — when a message continues an existing conversation, it checks the sender is the party that conversation belongs to; if not, it isolates them. Important protection against thread-hijacking.
- **Two delivery paths.** Over the internet ("relay") a message already carries the sender's fingerprint. On the *same computer* it carries the sender's *name*. That mismatch is the whole bug.
- **An address book** (`known-agents.json`) the agent already uses when *sending* to turn a name into an ID. The receiving side just wasn't using it.

## What this adds (and what review changed)

The first draft said "look up the sender's fingerprint." Review caught a real bug in that: in the actual address book, **Luna has no `fingerprint` field — only a `publicKey`**, and the conversation was filed using the first 32 characters of that publicKey. A naïve "read the fingerprint field" lookup would have come back empty and the fix would have *silently done nothing on the exact case it's meant to fix.*

So the corrected design has **one shared "work out the ID" routine** used by *both* the side that files the conversation and the side that checks it — using the identical recipe (`fingerprint`, else first-32-of-publicKey, else give up). Record and check can never disagree again.

Review also caught that handing the guard a *full* identity bundle would have quietly changed other things (how much history the new session sees, an extra "this is an external agent" preamble, and a stored record). So the fix now hands the guard **only the one fact it needs — the resolved fingerprint — and nothing else.** No other behavior changes.

## The new pieces

- **A tiny shared "name → fingerprint" routine** that both filing and checking call, using one recipe.
- **A single resolved-fingerprint hint** passed to the guard at the moment a same-computer message arrives. Just that one value — not a whole identity bundle.

## The safeguards

**The guard stays ON, and unknown senders are still isolated.** If a name can't be resolved (not in the address book, or no usable ID), no hint is passed and the old behavior applies — a fingerprint-filed conversation stays protected. We only let a reply through when its name resolves to the *exact* ID the conversation is already filed under.

**Honest, decided trust note.** Same-computer delivery is gated by a shared token, not a cryptographic signature, so a program already holding that token and stamping a known peer's name would resolve to that peer's ID and pass the guard. We've decided to accept this: the token is the real lock (unchanged), the guard was never a real lock on the same computer anyway (it just broke all replies), and the internet path — where an outside attacker would be — is cryptographically checked and untouched. Tightening *who may deliver locally* is a separate, tracked hardening, not this fix.

## What ships when

One pull request in the normal agent update — no relay/server deploy, because the receiving agent does the translation locally. It takes effect after the agent updates and restarts. A test reproduces the exact vanished-reply incident and proves it stops — in **both** directions.

## What you actually need to decide

Do you approve teaching same-computer delivery to work out the sender's fingerprint the same way the conversation was filed (handling the publicKey-only case), and hand the anti-hijack guard just that one fact — so it stops quarantining legitimate replies — while keeping the guard fully active, isolating any unresolved sender, and changing nothing else?
