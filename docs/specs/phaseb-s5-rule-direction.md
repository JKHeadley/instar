---
title: "A Standards Change Must Carry Its Direction"
slug: "phaseb-s5-rule-direction"
author: "instar-codey"
parent-principle: "Structure beats Willpower"
eli16-overview: "phaseb-s5-rule-direction.eli16.md"
lessons-engaged: "Structure beats Willpower; Honest Denominators; Verify the State, Not Its Symbol; Signal vs Authority"
approved: true
approved-by: "Pathway, Phase B orchestrator (topic 29723)"
approved-date: "2026-08-17"
review-convergence: "2026-08-17T17:30:00.000Z"
review-iterations: 3
review-completed-at: "2026-08-17T17:30:00.000Z"
review-report: "docs/specs/reports/phaseb-s5-rule-direction-convergence.md"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 3
---

# A standards change must carry its direction

## Operator intent

Phase B lane S5 reproduced two ways the live standards-coverage ratchet could
be made to approve a weaker constitution. Deleting an unguarded article raised
the aggregate score because the item left its own denominator. Rewriting the
foundational obligation as optional kept every score unchanged. In both cases,
the changer could refresh the existing content attestation and make CI green.

The guard must distinguish a mechanical removal from an edit, keep removed
articles in the continuity denominator, and require direction-bearing
ratification that the changer cannot author alone. It must run through the
existing standards-coverage pipeline and fail closed when either the protected
base or the approval trust root cannot be read.

## Grounded current state

The existing script parses 88 Rule-bearing articles, grades named enforcement
references, and binds each family audit to its current digest. It does not give
articles immutable identities, preserve a population after deletion, or bind a
review to an edit direction. Its existing family evidence is written in the
candidate tree by the same principal making the change.

The repository's approver key file is presently a comments-only placeholder.
This change therefore ships fail-closed for constitutional amendments until an
independently controlled Ed25519 public key is committed to protected main. The
matching private key must remain outside the repository, agent-readable
credential stores, and build environments.

## Decisions

### 1. Hybrid direction model

Addition and removal are computed mechanically from stable article identity.
Edits declare one of `strengthen`, `neutral`, or `weaken`; the declaration is
accepted only when an independent Ed25519 signature covers the exact protected
base revision, both registry hashes, article identity, before/after summaries,
direction, approver identity, and timestamp. The guard does not infer semantic
strength from prose or keywords.

### 2. Article identity and rename cost

An explicit Article ID is immutable. Existing articles without one receive a
deterministic legacy identity derived from family and heading. A legacy heading
rename is consequently remove-plus-add and requires independent ratification.
That friction is deliberate and documented: identity changes cannot silently
erase continuity.

### 3. Protected-base trust root

Both the article inventory and approver public key are read from the protected
base, never from candidate bytes. Replacing the candidate key and signing with
its matching private key must still fail. Candidate pin drift itself must fail,
including a pin-only change with no registry delta, so an attacker cannot move
the goalposts in one commit and weaken the rulebook in the next. Bootstrap or
rotation requires an explicitly separate protected-main control-plane action;
an ordinary candidate cannot authorize its own future authority. The CI workflow
extracts both protected inputs from the base revision before invoking the guard.

### 4. Honest continuity denominator

The aggregate and family ratios use the union of protected-base and candidate
article identities as their denominator. A removal remains represented and can
never improve a headline ratio merely by leaving the candidate population. The
current-population ratio remains separately visible and holds no floor authority.

## Decision points touched

- Standards-change acceptance is a deterministic policy authority over a closed
  domain: exact identities, hashes, signature validity, and declared direction.
- Semantic direction remains human judgment. The code verifies the declaration
  and its independent ratification; it does not classify prose.
- Unknown input, missing base material, empty population, malformed approval,
  or unreadable trust root yields `not-proven` and a failing pipeline exit.

## Acceptance criteria

1. The real standards-coverage entry point passes on the pristine registry.
2. An article deletion fails as `REMOVAL`, keeps the continuity denominator at
   88, and cannot be cleared by refreshing the old family attestation.
3. A foundational weakening fails as `WEAKENING` and cannot be cleared by the
   old self-authored attestation.
4. A valid strengthening signed by an independent fixture principal passes.
5. Replacing the candidate trust pin with an attacker key and signing with its
   private key fails because verification uses the protected-base pin.
6. A pin-only candidate change fails before it can become the next protected
   base authority.
7. The five-property battery and all four negative controls bite with the
   type-preserving hollow producing executed assertion failures.
8. CI extracts the registry and approver pin from its protected base and invokes
   the wired guard through `scripts/standards-coverage.mjs --check`.

## Rollback

Revert the guard module, coverage-script integration, CI extraction steps,
approval ledger, documentation, and tests together. No migration or runtime
state repair is required. The old coverage behavior returns immediately.
