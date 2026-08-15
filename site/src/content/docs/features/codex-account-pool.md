---
title: Codex account pool
description: Hold more than one Codex login, and move work off one that goes slow.
---

Instar deliberately runs its small background judgements — classifying intent,
checking whether a claim is finished, reviewing tone — on a **second** provider, so
they don't consume the main subscription you pay for.

That only works while the second provider is healthy. When it degrades, two things
go wrong at once: every failure falls through onto the main subscription (the exact
thing the second provider exists to protect), and each stalled request holds one of
the machine's shared spawn slots until it times out.

This feature lets you hold **more than one** Codex login, and lets Instar move work
off one that has gone slow.

## Enrolling a Codex account

The subscription pool refuses to add an account whose credential slot it cannot
identify. That guard matters: two pool rows silently pointing at the *same* login
would make "switch to the other account" a switch to itself.

A Codex credential slot identifies itself locally. `readCodexSlotIdentity` reads the
OIDC id_token already present in the slot's `auth.json` and returns the account's
email, a stable per-account id, and the plan tier — with no network call.

`CompositeCredentialIdentityOracle` puts that in front of the existing Anthropic
identity check. The identity contract is handed only a directory path, so the slot
has to answer for itself: a Codex home holds that token, an Anthropic home does not.
A slot that is not a Codex home takes the identical pre-existing Anthropic path.

Reading a credential never exposes it — the reader returns an email, an account id
and a plan, and no token material.

:::note
Identity is a **label**, never a permission. Knowing which account is signed in
names a row in a list; it grants nothing.
:::

## Choosing an account per call

An internal Codex call can name which account it runs on, via `resolveAccount` on
the Codex provider. Absent or null, the call behaves exactly as before — the
ambient login. A resolver that throws or returns something malformed also falls back
to the previous behaviour: losing account *selection* is a small loss, losing every
internal Codex call is not.

## Knowing which account is unwell

Instar's usual LLM metrics are recorded against the **component that asked**, which
is the right shape for "what does this feature cost" and the wrong shape for "is
this account unwell".

`CodexAccountHealth` supplies the missing dimension: a bounded, in-memory,
time-windowed record of p50 latency and error rate **per account**.

It refuses to answer when it cannot answer honestly. With too few samples in the
window it returns nothing rather than a number — because a trigger acting on two
samples would move live sessions on noise. It is deliberately not persisted: health
is a claim about the last few minutes, and a reading resurrected across a restart
would be a confident answer about a world that no longer exists.

## Moving work off a degrading account

The proactive swap monitor gains a `degradation` trigger alongside its existing
quota trigger. An account that is slow **or** failing becomes a candidate to move
off, regardless of how full it is — which is the point, since quota is often not the
problem.

It bypasses only *source* pressure. Target freshness, per-target ceilings,
anti-thrash dwell and execution-time revalidation all still apply, and the swap
machinery still refuses to cross frameworks — so a Codex session can only ever move
to another Codex account, never onto the main subscription's account.

### Safety

- **Dark by default.** The trigger ships off.
- **Rehearses first.** When switched on it starts in dry-run: it records the exact
  swap it *would* have made and leaves the session alone.
- **Unknown is not degraded.** No data, too few samples, or a broken gauge all mean
  unknown — and unknown never moves anything.

## Configuration

Nothing is enabled by default, and nothing is enrolled automatically. Enrol a Codex
account through the normal subscription-pool enrolment path, pointing at that
account's credential home.
