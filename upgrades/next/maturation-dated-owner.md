# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The Maturation Path article in the constitution gains clause (h), which has two halves.

- **A dated owner.** The next rung of a switched-off feature's ladder names an owner and a review-due date when the feature ships, and each later rung gets them when the rung below it is reached, written on the feature's ladder entry. A reminder may also come back as a commitment or a message, but the ladder entry is the record. A rung waiting for review is treated as a tracked deferral: it is closed with evidence, re-dated with a recorded reason, or taken to the operator before its date, and it never lapses quietly.
- **Proven awake.** The tools that notice a stalled feature (the maturation ladder, the Growth & Milestone analyst, and queue-pace) must be shown to work on the agent and machine running a feature's trial before that rung's clock starts. The proof is a check whose answer is already known.

Nothing checks either half yet, and the article says so. The dated-owner half shares the existing deadline for ship-time registration (clauses (c) and (d)). The proven-awake half has its own. Both deadlines are 21 December 2026, and a build fails if either passes with nothing done.

## What to Tell Your User

Nothing changes for you today. The rule for switched-off features now says each one gets a named owner and a review date the day it ships, so a feature can no longer sit switched off for months because nobody was assigned to look at it.

## Summary of New Capabilities

None. This changes the rule text only. The ladder fields and the checks that will enforce it come in later changes, due by 21 December 2026.

## Evidence

Operator directive in topic 139880, 6 November 2026. Shipping family audit: `docs/audits/maturation-dated-owner-shipping-family-2026-11-14.json` and `docs/specs/reports/maturation-dated-owner-shipping-family-2026-11-14.md`, with an independent review.
