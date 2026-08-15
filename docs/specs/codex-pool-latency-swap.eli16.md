# Giving Codex a second lane — Plain-English Overview

> The one-line version: the agent's background thinking runs on a second account
> so it doesn't spend the main subscription — that account has become slow and
> unreliable, and there is a spare sitting unused because nothing could enrol it.

## The problem in one breath

Most of the agent's small background judgements — classifying intent, checking
whether a claim is finished, reviewing tone — deliberately run on a **second**
provider so they don't consume the main subscription the operator pays for.

That second provider has degraded badly. Measured, not guessed: the very simplest
request takes about **thirteen seconds**, and several of those background checks
now sit at **sixty seconds**, which is the cut-off — meaning they aren't failing,
they're running out of time. The failure rate went from roughly a quarter over
three days to **most requests in the last hour**.

Two things make that worse than slow background work:

- **Every failure falls through to the main subscription** — the exact thing the
  second provider exists to protect.
- **Each stalled request occupies one of eight shared slots** until it times out.
  When they crowd it, the agent's own replies to the operator can't get a slot and
  are held back. That is not theoretical; it delayed a live demo.

And there is a **second account for that provider already signed in on this
machine, completely unused** — because nothing could enrol it.

## Why the spare account could not be enrolled

The pool that holds these accounts refuses to add one whose identity it cannot
verify — a sensible guard, since two entries silently pointing at the *same*
login would make "switch to the other account" a switch to itself.

But the only identity check available asks **Anthropic's servers** who is signed
in. Handed a Codex account, it cannot answer, so enrolment fails. The pool held
six Anthropic accounts and zero Codex ones, not by policy but because the door
was the wrong shape.

## What this adds

**A Codex account can now identify itself.** Its credential file already contains
a signed identity card listing the account's email, a unique account id, and the
plan — no network call needed. Reading it closes the enrolment gap.

**A slowness trigger, not just a fullness trigger.** The machinery that moves work
to a healthier account today only reacts to an account being *used up*. Quota is
not the problem here — the account is at seventeen percent. The trigger is being
taught to react to an account being *slow or erroring* as well.

**Prefer the sibling before the expensive one.** When a Codex request fails today,
the next thing tried is the main subscription. It should try the *other Codex
account* first, and only fall back to the expensive one if both are unwell.

## The safeguards

**Nothing moves on its own yet.** The new trigger ships switched off, and when
switched on it starts in a rehearsal mode that only writes down what it *would*
have done. A live session is not moved until someone reads those notes and decides.

**It cannot mix up the two kinds of account.** A Codex session can only ever be
moved to another Codex account, never to the main subscription's account — that
restriction already existed and was verified before relying on it.

**Reading a credential cannot leak it.** The identity reader returns an email and
an account id and nothing else. A test plants a fake secret in the file and proves
it appears nowhere in the result — with a control confirming the fake secret really
was in the bytes being read, so a clean result means something.

**Identity is a label, never a permission.** Knowing which account is signed in
names a row in a list. It grants nothing.

## What ships when

The identity reader and the enrolment path are useful immediately — they make the
spare account visible and usable. The slowness trigger ships dark and rehearses
first. Nothing about the main subscription changes.
