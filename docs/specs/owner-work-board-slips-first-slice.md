---
title: "Approve an exact set of Work Board cards from the paired iPhone"
slug: owner-work-board-slips-first-slice
author: Echo
tier: 2
status: implementation-concurred
eli16-overview: owner-work-board-slips-first-slice.eli16.md
---

# Approve an exact set of Work Board cards from the paired iPhone

This design supersedes the first-build scope of [finite permission slips](owner-permission-slips.md). The original draft and its review remain the record for follow-up work. The first use is the six rewritten morning cards after they are available for owner review. Use disposable cards for implementation testing.

## Proposal and consent

A proposal accepts one explicit list of existing cards awaiting owner approval from an authenticated owner request. Refuse duplicate, ambiguous, unsupported, or ineligible items at issuance. Store one immutable set per authenticated source, with the source locator and digest. A retry returns the same set. A different set requires a fresh authenticated request. The proposal captures the ordered card IDs, the exact immutable card revisions, the canonical owner-visible text and its hash, and the sole action Approve. The server supplies the display and binds it all to one digest. A chat link is a locator for the existing app approval surface. The app shows every item and its exact approval effect before requesting presence and offers no partial substitute for incomplete display.

The paired owner iPhone uses the existing fresh Face ID or Touch ID approval proof, with system device passcode fallback where the existing path supports it. Give slips a distinct signed purpose, bound to the agent origin, verified current owner, enrolled presence key generation, slip ID, proposal digest, authority epoch, nonce and challenge expiry. The slip expires 24 hours after issuance, and the challenge expires independently under the existing policy. The authority durably consumes the single-use decision before applying any item. Replay of that decision returns its receipt. Refuse approvals where the current serving writer or its durable receipt state cannot be verified.

## Production writer

Use a pinned Work Board writer for an explicitly enabled board epoch. The writer assignment binds agent, board, accepted owner generation, machine incarnation, and a sealed baseline of the Work Board streams. Initially it has no automatic failover. A process must hold the exclusive agent-home writer lock and prove its exact assigned machine incarnation and current owner generation before admitting an epoch write. The assignment cannot follow a generic service lease or re-elect on uncertainty. Pending decisions are scoped to that epoch. A restart can reopen proven durable state on the same writer. Moving, restoring or replacing the writer needs a separately reviewed cutover. Until then the feature is unavailable if the original writer or its durable state cannot be proven.

Install enforcement at the production Work Board emit boundary below the routes and reject admission on every other machine. Route console single approval, console bulk approval, paired-phone ordinary approval and slip approval into the same WorkBoardService writer. Relevant edits, withdrawals and policy changes go through the same boundary so that none can land between the version check and event append. Existing route authorization remains in front of that writer. Current reads can use replicated projections. In the enabled epoch a nonwriter returns an explicit unavailable result and an authenticated, configured writer entry point when the client can reach it with existing credentials. Clients must use ordinary verification at that origin. No credential is forwarded to a different origin, and a client on an old build cannot approve through a peer.

Activation requires evidence that every accepted machine enforces the same epoch and old-origin write fence, a complete caught-up baseline, and a verified writer lock. The epoch applies to the whole board mutation stream because per-route checks cannot account for delayed edits or an alternative producer. Replication admits baseline records and current-epoch records only from the assigned machine incarnation. After sealing the baseline, unexpected authority records fence the epoch and surface the conflict without applying them. Changes to accepted membership or owner generation invalidate the activation proof. Until an installation proves this boundary, preserve current ordinary approvals and leave slips unavailable. An enabled epoch with lost proof refuses board mutations. It does not silently fall back to old peer writes. Test real mixed-version refusal before activating the six-card use.

## Application and receipts

Each signed item is an independent conditional approval. Under the Work Board writer, re-read the exact revision, visible text hash and owner-approval eligibility before recording the event. A changed card is excluded and needs a newly issued slip. If an ordinary approval already won, show that outcome. Apply and ordinary approval must use one serialized decision point for the same approval generation. There must be one authoritative Work Board event and one set of downstream projections with attribution to the actual winner. Reconcile a lost response from that event and its durable cause. If the outcome cannot be established, show unresolved and stop that item. A new or restored writer may not resume inherited work without independently verified durable evidence and a current fence. Ordinary Work Board policy and pickup gates apply.

The first write for an eligible generation is a compare-and-set inside the pinned writer. Build the generation from the card’s last authoritative revision and the effective Work Board policy revision under the current board epoch. A reversal or intervening edit changes the generation even if the visible text returns to its earlier value. Within the same synchronous writer turn, compare the expected generation, recompute the owner-visible digest, verify eligibility, then append at most one event with a stable ID derived from the board epoch, card and generation. An existing committed event returns its recorded winner and does not generate another tap. Make the winning cause and its provenance recoverable from the event, with authenticated source attribution and a slip decision reference when applicable. An ordinary approval racing after a slip sees the winning event. A slip racing after ordinary approval reports that independent winner without claiming its effect.

A slip decision record stores the consumed nonce and exact signed set durably before the writer attempts any item. The normal Work Board journal supplies the event sequence. Await its actual durable watermark or prove the exact committed event by readback before reporting applied or releasing pickup for that event. A provisional approval event stays unavailable to pickup and projections until durability is known. Preserve the deterministic transcript projection and pickup cause keyed by the winning event. Recovery checks its durable identity before resuming a decision. If the checkpoint, writer epoch or exact event outcome is uncertain, fence the item and return unresolved. A retry can return a prior receipt when the exact event is proven. It cannot repeat an uncertain effect.

Standing grants, other operations, trust widening, automatic grouping or regrouping, and general cross-writer continuation are follow-ups.

## Decision points touched

- Bind the action to the exact card revisions and visible text — invariant; basis: irreversible-consequence; evidence: the owner reviewed and can authorize only the disclosed approval.
- Verify fresh owner presence and consume one decision — invariant; basis: irreversible-consequence; evidence: copied links or replayed decisions must not approve cards.
- Expire slips 24 hours after issue — judgment-candidate. The current scope decision sets this limit. Changed cards require fresh review even within that window.
- Share an approval generation across slip and ordinary owner taps — invariant; basis: irreversible-consequence; evidence: concurrent approval or retry must not create a second cause or misattribute the first.

## Verification

Test exact signed bindings, disallowed actions, invalid owner or device, expired slips, ambiguous input, stale text and revision, replay, both ordinary-approval race orderings, lost replies and loss of the serving writer. HTTP tests run the real existing owner-device proof and require explicit confirmation. Lifecycle tests open the app approval entry and prove a six-card fixture affects only the eligible unchanged cards. Verify the resulting receipts and unchanged pickup gates. The native passcode fallback requires device evidence.

## Frontloaded decisions

- Chief of Staff selected one enforced writer for this slice. Pin the board epoch to a specific enrolled machine incarnation and seal the migrated baseline. Independent review concurred on November 24, 2026. This slice has no automatic failover.
- Activation requires production evidence across mixed-version peers, owner and membership changes, a lost writer and local durability recovery. Keep the feature dark while that evidence is incomplete.
- The authority checks are deterministic. The enrolled owner, writer assignment, exact revision and durable commit are authority records. A capability signal or lease announcement cannot substitute for one of them.

## Open questions

None.
