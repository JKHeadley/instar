---
title: "Approve an exact set of Work Board cards from the paired iPhone"
slug: owner-work-board-slips-first-slice
author: Echo
tier: 2
status: focused-review
---

# Approve an exact set of Work Board cards from the paired iPhone

This design supersedes the first-build scope of [finite permission slips](owner-permission-slips.md). The original draft and its review remain the record for follow-up work. The first use is the six rewritten morning cards after they are available for owner review. Use disposable cards for implementation testing.

## Proposal and consent

A proposal accepts one explicit list of existing cards awaiting owner approval from an authenticated owner request. Refuse duplicate, ambiguous, unsupported, or ineligible items at issuance. Store one immutable set per authenticated source, with the source locator and digest. A retry returns the same set. A different set requires a fresh authenticated request. The proposal captures the ordered card IDs, the exact immutable card revisions, the canonical owner-visible text and its hash, and the sole action Approve. The server supplies the display and binds it all to one digest. A chat link is a locator for the existing app approval surface. The app shows every item and its exact approval effect before requesting presence and offers no partial substitute for incomplete display.

The paired owner iPhone uses the existing fresh Face ID or Touch ID approval proof, with system device passcode fallback where the existing path supports it. Give slips a distinct signed purpose, bound to the agent origin, verified current owner, enrolled presence key generation, slip ID, proposal digest, authority epoch, nonce and challenge expiry. The slip expires 24 hours after issuance, and the challenge expires independently under the existing policy. The authority durably consumes the single-use decision before applying any item. Replay of that decision returns its receipt. Refuse approvals where the current serving writer or its durable receipt state cannot be verified.

## Application and receipts

Each signed item is an independent conditional approval. Under the Work Board writer, re-read the exact revision, visible text hash and owner-approval eligibility before recording the event. A changed card is excluded and needs a newly issued slip. If an ordinary approval already won, show that outcome. Apply and ordinary approval must use one serialized decision point for the same approval generation. There must be one authoritative Work Board event and one set of downstream projections with attribution to the actual winner. Reconcile a lost response from that event and its durable cause. If the outcome cannot be established, show unresolved and stop that item. A new or restored writer may not resume inherited work without independently verified durable evidence and a current fence. Ordinary Work Board policy and pickup gates apply.

Standing grants, other operations, trust widening, automatic grouping or regrouping, and general cross-writer continuation are follow-ups.

## Decision points touched

- Bind the action to the exact card revisions and visible text — invariant; basis: irreversible-consequence; evidence: the owner reviewed and can authorize only the disclosed approval.
- Verify fresh owner presence and consume one decision — invariant; basis: irreversible-consequence; evidence: copied links or replayed decisions must not approve cards.
- Expire slips 24 hours after issue — judgment-candidate. The current scope decision sets this limit. Changed cards require fresh review even within that window.
- Share an approval generation across slip and ordinary owner taps — invariant; basis: irreversible-consequence; evidence: concurrent approval or retry must not create a second cause or misattribute the first.

## Verification

Test exact signed bindings, disallowed actions, invalid owner or device, expired slips, ambiguous input, stale text and revision, replay, both ordinary-approval race orderings, lost replies and loss of the serving writer. HTTP tests run the real existing owner-device proof and require explicit confirmation. Lifecycle tests open the app approval entry and prove a six-card fixture affects only the eligible unchanged cards. Verify the resulting receipts and unchanged pickup gates. The native passcode fallback requires device evidence.

## Open questions

Focused review must establish whether the current Work Board writer and native approval path can enforce the required durable, fenced decision and exact-version race behavior.
