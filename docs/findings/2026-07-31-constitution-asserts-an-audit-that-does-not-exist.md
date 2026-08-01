---
title: "Exactly one constitutional standard claims a running guard it does not have — and it is the one earned from the worst outage in our record"
date: 2026-07-31
author: echo
machine: Mac Mini
severity: high
status: open
kind: finding
relates:
  - "docs/STANDARDS-REGISTRY.md"
  - "docs/postmortems/2026-07-01-silent-telegram-message-loss.md"
  - "src/core/senderValidationGate.ts"
---

## What was measured

The standards-coverage audit reports 24 standards as `documented-only` — no resolvable guard. That
count treats every gap alike. It is not alike, and the distinction matters more than the number.

I partitioned the 24 by a sharper question: **does the standard's own prose assert that machinery
is already running?** A standard that says "this is how we should behave" and names no guard is an
honest gap. A standard that says "a scheduled audit walks the list daily" is making a claim of
fact, and that claim is either true or it is a false all-clear sitting in the constitution.

**Three of the 24 make such a claim. I verified all three.**

| standard | its claim | verified |
|---|---|---|
| Observation Needs Structure | "the cycle store **refuses** a record without an operator-seat verdict" | **TRUE** — pinned by a unit test; now cited |
| A Refusal Stays a Refusal | "enforcement **is** a test ratchet on the routing boundary… **fails the build**" | **TRUE** — pinned by a unit test; now cited |
| Cross-Store Coherence Is an Invariant | "**A scheduled coherence audit walks the list on every machine daily**" | **FALSE** — no such audit exists |

Two were guards that existed and had merely never been named — bookkeeping, now closed. The third
is a different thing entirely.

## The one that is false

**Cross-Store Coherence Is an Invariant** requires that any two stores answering the same question
have a *declared agreement invariant* "checked on a cadence by machinery," and enumerates three:

1. every verified topic-operator uid resolves in the user registry
2. machine-registry freshness agrees with live pool heartbeats
3. a topic's pinned model matches the actually-running process

What actually exists:

| invariant | checker | when it runs |
|---|---|---|
| 1 — operator uid ↔ user registry | `src/core/senderValidationGate.ts` | **per inbound message, current topic only** |
| 2 — machine registry ↔ pool heartbeats | none found | — |
| 3 — pinned model ↔ running process | none found | — |
| the declared *list* + cadenced walker | none found | — |

There is no scheduled job, no invariant list, and no daily walk. Two of the three named invariants
have no checker at all.

## Why the one checker that exists does not discharge the standard

`SenderValidationGate` is real, well-built, and genuinely checks invariant 1 — it disarms and
raises a HIGH alert when the current topic's locally-bound operator uid does not resolve in the
registry, which the file itself calls "the incident's exact signature."

But it is a **delivery-time fail-safe, not a coherence audit**, and the difference is the whole
point of the standard:

- **It only fires when a message arrives** on an affected topic. On a quiet topic, drift is
  invisible for as long as the topic stays quiet.
- **It sees one topic per call** — the current one — never the population.
- **It fires at the moment of harm.** In the original incident the contradiction became visible
  precisely when messages started being dropped. A guard that triggers as the outage begins is a
  blast shield, not a tripwire.

The standard was earned from a case where "two authoritative identity stores contradicted each
other for **19 days** with no tripwire." The reactive shield shipped. **The tripwire — the thing
whose absence made 19 days possible — did not.**

## The blind-spot class

> **A standard that describes its own enforcement in the present tense is making a testable claim,
> and nothing tests it.** The coverage audit checks whether a rule *names a resolvable file*; it
> cannot check whether a rule's prose *asserts machinery that exists*. So the failure mode is
> narrow but severe: a standard can read as protected — to a human, which is who reads the
> constitution — while being a `documented-only` gap, and the gap count gives no hint which ones
> those are.

This is the same shape as everything else found today, applied to the constitution itself: an
instrument that reports confidently about something it never actually checked. Here the instrument
is our own founding document.

## What closes it

1. **Build the audit, or amend the sentence.** Either is honest; the present state is not. If the
   cadenced audit is the right thing, it is cheap — the finding that earned this standard says so
   explicitly: *"The audit is deterministic and cheap — the barrier was never cost, it was that
   nobody declared the invariants."* If it is not worth building, the prose must stop claiming it.
2. **A lint for present-tense enforcement claims.** A standard whose Rule/In-practice asserts
   running machinery ("a scheduled X", "fails the build", "refuses", "checked on a cadence") must
   name a resolvable guard, or fail the coverage check as a *false claim* rather than passing
   silently as an ordinary gap. This generalizes: it makes the constitution's self-description
   checkable, which is exactly what the constitution asks of everything else.

## Honest limits

- The detection pass that shortlisted the three used a keyword match over each standard's first
  six lines. It could under-report — a standard asserting machinery in wording I did not pattern
  for would be missed. The three it found were each verified by hand against the source; the
  *absence* of a fourth is not verified to the same standard.
- The negative claims for invariants 2 and 3 rest on targeted greps for the concepts and for any
  declared-invariant list, all of which came back empty. A checker existing under naming I did not
  anticipate is possible, though the absence of any invariant list makes a cadenced walker
  unlikely by construction.
- `senderValidationGate`'s quality is not in question here. It does what it says. The finding is
  about the standard's claim, not the gate's behaviour.
