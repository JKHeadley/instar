# Conversation and Effort Hierarchy — Review Round 3

**Reviewed:** `conversation-effort-hierarchy-v2.md`, 2026-11-04. **Status:** design review in progress. DAWN's substantive review is pending; no convergence claim.

## What advanced

- Compared the installed `CoherenceJournal`, `JournalSyncApplier`, `ReplicatedRecordEnvelope`, `InitiativeTracker`, and `AppConversationStore` contracts. The graph now has a preferred typed journal transport and an explicit requirement to register the new kind in both registries.
- Separated graph placement from TaskFlow work status and native app transcript events. The generic replicated record's last-writer-wins merge cannot be the final placement authority, because two concurrent user moves must remain visible.
- Added projection revision, safe pagination, offline correction revalidation, conflict response, and privacy filtering before counts, search, and digests.
- Sent DAWN the concrete v1 architecture/product choices and four focused review questions over Echo's connected Threadline relay. Delivery succeeded; no substantive answer yet.

## Design findings that still block convergence

1. **P1 — Event transport and recovery proof.** Verify the chosen journal seam can retain or snapshot all graph events, recover after a replication gap, and give identical event sets and projections on two machines. The current substrate has bounded retention and gap reporting; the design cannot treat transport alone as durable graph authority.
2. **P1 — Access model.** Define the viewer principal and authorization predicate across owner/MSP roles, topic bindings, platform availability, and graph membership. Test that inaccessible children cannot affect counts, cursors, search, digest text, or notification selection. Confirm dashboard and mobile routes share this predicate.
3. **P1 — Conflict reducer.** Specify the causal comparison used for two user moves, whether a move to an inaccessible parent is rejected or held, and how conflict resolution itself replicates. Do not let HLC total order silently choose a winner.
4. **P2 — Product validation.** Build a narrow-phone interaction prototype and test finding a deep worker, resolving a conflict, and returning to the front door with keyboard and screen reader access.
5. **P2 — Inference and attention calibration.** Pilot with real topic trees to measure history coverage, false placement suggestions, digest citation quality, and parent notification volume before enabling automatic placement or default hiding.
6. **External review — DAWN.** Incorporate her first-hand topic-history failure cases and parent-report preferences; record agreement or disagreement with the architecture choices.

## Review verdict

The v2 draft is a concrete starting implementation contract for the Conversations hierarchy and multi-machine store. It is not converged. Resolve P1 findings and DAWN's review before an implementation handoff or user-facing default change.
