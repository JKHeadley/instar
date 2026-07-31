# Standards False-Claim Guard — Plain-English Overview

> The one-line version: a rule in our constitution may no longer say "a scheduled check does this daily" unless it names the thing that actually does it.

## The problem in one breath

We have a build check that measures how many of our 81 constitutional rules are genuinely protected
by something that runs. It works by asking whether a rule *points at* a real file. It cannot ask
whether a rule *claims* to be protected. So a rule can describe machinery in the present tense —
"a scheduled coherence audit walks the list on every machine daily" — while no such audit exists,
and the check reports it as an ordinary unguarded rule, indistinguishable from one that never
claimed anything. A human reading the constitution sees a protection that isn't there.

Measured on 2026-07-31: of the 22 rules with no named guard, exactly three assert running
machinery. Two were true and had simply never named their guard (both are now cited). The third —
Cross-Store Coherence — is false. Of its three listed invariants, one has a per-message
delivery-time fail-safe and two have no checker at all. It is the rule earned from the incident
where two of our identity records disagreed for nineteen days with nothing noticing.

## What already exists

- **The coverage check** — reads every rule, extracts any file, route or symbol it names, verifies
  those exist on disk, and classifies the rule by the strongest guard it names. Fails the build if
  the protected share drops below a committed floor, or if a rule ever cites a guard that has been
  deleted.
- **The floors** — a protected-share floor that ratchets upward as gaps close, and a zero-tolerance
  ceiling on citations that don't resolve.

Both already work. This adds a third question to the same pass.

## What this adds

One new measurement and one new floor. For any rule the check has *already* concluded names no
guard, it now also asks: **does this rule's own text assert that machinery is running?** If yes,
that rule is counted as a *false claim* rather than an ordinary gap, named individually in the
build output, and counted against a ceiling.

- A per-rule line in the output naming the exact phrases that triggered it, so the finding is
  actionable without re-reading the constitution.
- A ceiling that starts at the currently measured value, so no existing build breaks.

## The new pieces

- **The claim detector** — a small set of patterns for assertions of a specific running mechanism
  ("a scheduled audit", "walks the list", "fails the build", "checked on a cadence"). It is *not*
  allowed to fire on a rule that names a guard, because it only ever sees rules already classified
  as naming none. It is *not* allowed to fire on a requirement — "must be checked on a cadence" is
  a rule being stated, not a claim being made, and prescriptive wording is excluded explicitly.

## The safeguards

**Precision comes from where it runs, not from tuning the patterns.** The detector only sees rules
that name no guard at all. A rule that both claims machinery and cites it is never examined. So the
only way to be flagged is to claim a mechanism and point at nothing — which is exactly the
condition we want flagged, and there is no configuration that widens it.

**It cannot break a build that is not already broken.** The ceiling defaults to the measured count
(1), following the same "starts loose" approach the protected-share floor used. It is still doing
real work at that value: a *new* rule that claims an unnamed guard fails immediately. The ceiling
drops to zero once the one existing false claim is resolved — either by building the audit it
describes, or by amending the sentence that describes it.

**It is a build check, not a runtime gate.** It blocks nothing an agent does, delays no message,
and touches no user-facing behaviour.

## What it deliberately does not do

It does not decide whether a guard is *sufficient* — only whether a rule that claims one has named
one. A rule can name a real, resolvable, running guard that does its job badly, and this check will
be satisfied. That is the same limit the existing coverage check has, and it is worth restating
rather than quietly inheriting: this closes a bookkeeping gap, not a safety gap.

## How you would know it was wrong

If it fired on a rule that was merely *describing a requirement*, the ceiling would rise without a
real false claim behind it. Four tests pin the boundary in both directions: a claim with no guard
fails; the same claim with a resolvable guard passes; a prescriptive "must" passes; an ordinary
unguarded rule passes.
