# PROPOSED AMENDMENT — Deferral Lifecycle

**Status:** Proposal only. Not ratified and deliberately not written into the standards registry.
**Proposed family:** Shipping.
**Proposed disposition:** Amend *No Deferrals* and reuse the existing documented-only countdown
shape. Do not create a second generic follow-through mechanism.

## The obligation

Every tracked deferral must have an owner, a review deadline, and a terminal path: close it with
evidence, deliberately re-date it with a reason, or escalate it to the operator before expiry; a
tracked deferral may never expire silently.

Tracking is the start of the lifecycle, not proof that active follow-through happened.

## Proposed forcing mechanism

Extend the existing countdown machinery to a deferral record rather than minting a parallel lint.
The record should carry a stable deferral ID, owner, current deadline, status, linked commitment or
issue, and terminal evidence. Before the deadline, closure records the result; deliberate re-dating
records who chose it, why, and the next date; expiry produces a visible escalation and refuses a
claim that the deferral remains healthy. Re-dating is legal—“ship it or delete it” is not a safe
engineering rule—but it must be an explicit, auditable action rather than a silent date edit.

The population weakness must remain visible: the current countdown lint sees declared countdown
records, not every sentence in every document. A deferral written only as prose, or a new marker
shape not consumed by the inventory, can escape. Discovery of all deferrals is not certified by the
mechanism.

## What it would measure and certify

**Measure:** the declared deferral population, stable IDs, owners, deadlines, status transitions,
closure evidence, re-date reasons, and escalation records.

**Certify:** only that a declared deferral is tracked and currently has a valid, unexpired lifecycle
state or a terminal escalation. It does not certify that the deferred work was the right thing to
defer, that the closure evidence is adequate, or that an undeclared deferral does not exist.

## A deferral that would escape

A spec says “we will revisit this after rollout” in ordinary prose without the recognized marker.
The existing population scan sees no deferral, the countdown stays green, and the obligation is
silently abandoned. This is not a reason to claim universal discovery; it is the named negative
control the future guard must retain.

## Relationship to Close the Loop

*No Deferrals* owns this specific lifecycle: capture, deadline, closure/re-date, and escalation for a
declared deferral. *Close the Loop* owns the broader temporal principle that every opened loop gets a
cadence, and it remains documented-only until its own 2026-09-07 countdown. The deferral record is a
first concrete consumer of that cadence shape, not a replacement for the universal article and not a
second owner of universal follow-through.

The shared countdown machinery should eventually consume both populations through one lifecycle
record format. Until that adapter exists, this proposal must not say that *No Deferrals* is enforced
by *Close the Loop*; that was the original overclaim.

## Enforcement honesty and countdown

The existing orphan-deferral check certifies that a declared deferral is tracked. It does not force
closure, re-dating, or escalation, and the countdown lint does not currently discover prose-only
deferrals. The amendment is therefore **documented-only until 2026-09-07**, tracked as
`STD-COUNTDOWN-deferral-lifecycle`, unless the shared lifecycle guard lands first.
