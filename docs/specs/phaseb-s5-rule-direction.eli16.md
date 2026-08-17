# Standards direction guard — plain-English overview

> The one-line version: changing Instar's rulebook must say whether the change
> strengthens, preserves, weakens, adds, or removes an obligation, and a second
> trusted principal must ratify the exact change.

## The problem in one breath

The standards checker noticed that rulebook text changed, but it did not know
whether the change made a rule stronger or weaker. Worse, deleting an unguarded
rule improved the score because the deleted rule disappeared from the number
being measured. In both cases the person making the change could write a fresh
"I reviewed this" record and clear the only objection.

## What already exists

- **A standards registry** — 88 articles, each with a normative Rule field.
- **A coverage ratchet** — CI measures how many articles name real enforcement
  and refuses numerical regressions.
- **Family audit records** — exact content hashes reveal an unacknowledged edit,
  but the changer can refresh those records without independent authority.

## What this adds

Every Rule-bearing article now has a stable identity. Additions and removals are
mechanical facts, while edits carry an explicit direction. A ratification is
valid only when a separately held Ed25519 key signs the exact base revision,
the before and after article hashes, the declared direction, and the approver's
identity and time. Replaying the signature after changing one byte fails.

The score's denominator also keeps the union of the old and new article sets.
Deleting an article therefore cannot make a smaller constitution look better.
The candidate-only score is still reported for visibility but cannot satisfy the
floor.

## The safeguards

**The changer cannot move the goalposts.** The approver public key is read from
protected main, alongside the protected article inventory. Replacing the public
key in the proposed change and signing with the matching attacker key is refused.
A pin-only change is refused too, closing the two-commit version of that attack.
Installing or rotating the real pin therefore needs a separately authorized
protected-main control-plane action, never an ordinary self-authorizing change.

**The checker does not pretend to understand prose.** Code does not guess that
"should" is weaker than "must." A human declares the semantic direction and an
independent principal ratifies the exact bytes. Mechanical facts stay mechanical;
judgment stays with an accountable principal.

**Unknown never means clean.** Missing base input, an empty article population,
malformed evidence, candidate pin drift, or an unavailable file produces
`not-proven` and makes CI fail. A comments-only or malformed protected key can
pass an unchanged registry, but it cannot validate any amendment signature, so
every rulebook change remains blocked.

## What ships when

The direction guard, continuity denominator, CI protected-base extraction,
approval ledger, documentation, and tests ship as one change. The repository's
current public-key file contains no operational key, so rulebook amendments are
blocked until an independently controlled public key is installed on protected
main. Its private half must never be available to repository-changing agents or
the build environment.

## What you actually need to decide

Approve the hybrid boundary: code determines identity and population changes,
while independently signed declarations carry semantic direction.
