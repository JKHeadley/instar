# PROPOSED AMENDMENT — Evidence Validation Ownership and Timing

**Status:** Proposal only. Not ratified and deliberately not written into the standards registry.
**Proposed family:** Shipping.
**Proposed disposition:** Amend *Side-Effects Review Gate* as the single owner of pre-ship content
validation; *Maturation Path* should reference that owner for graduation evidence rather than repeat
the rule.

## The obligation

Before a change makes a claim that can authorize commit, merge, ship, or graduation, its evidence
must have an identified validator, a recorded verdict, and a validation moment before that claim is
accepted; author assertion alone cannot certify high-consequence evidence.

## Who validates, and when

The author remains responsible for producing the artifact and declaring its scope. For a reversible,
non-user-facing, non-side-effecting change at the repository's lowest risk tier, author validation may
be sufficient if the artifact says so explicitly.

An independent reviewer is required for an objective high-consequence class: user-facing behavior,
irreversible or externally visible side effects, identity/ownership or data movement, money/quota,
runtime lifecycle changes, new enforcement machinery, and constitutional or release-gate changes.
The existing risk-floor/tier declaration supplies routing input; this proposal does not create a new
semantic classifier.

Validation happens at the last gate before the claim it supports: side-effects content is reviewed
before commit/merge, and graduation evidence is reviewed before each maturation transition. A later
review is not allowed to retroactively turn an unsupported ship claim into evidence.

## What it would measure and certify

**Measure:** validator identity and independence class, artifact hash and scope, timestamp, checklist
verdict, rejected dimensions, and the claim/decision the artifact is permitted to support.

**Certify:** only that the named validator reviewed the named artifact against the named dimensions
and recorded a verdict before the relevant transition. It does not certify that the underlying system
is correct, that the reviewer was right, or that an omitted artifact does not exist.

## A passing input that fails the claim

A long artifact contains all five required headings, an author checks every box, and the presence
gate passes. The overreach section is blank in substance and no independent reviewer examined it.
The guard measured length and staging, but the claim “the side effects were reviewed” is false. This
is the exact distinction between an artifact existing and its content being validated.

## Cost and enforcement honesty

Independent review is a real throughput cost. It can serialize high-risk work and may require an
operator or peer when only one author is active. That cost is preferable to silently calling
self-attestation validation; low-risk author validation remains the bounded escape hatch.

The current side-effects gate proves artifact presence, not content, and the maturation path admits
that evidence quality remains reviewer judgment. No existing guard assigns or records the required
validator across both moments. The proposal is therefore **documented-only until 2026-09-07**, tracked
as `STD-COUNTDOWN-evidence-validation-ownership`, unless an ownership-and-verdict guard lands first.

The countdown remedy is one shared validation record consumed by the side-effects and maturation
transitions. It must not become two separate checklists that drift apart; presence, reviewer identity,
scope, and verdict are measured once, while content adequacy remains an honestly named human
certification.
