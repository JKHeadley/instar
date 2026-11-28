---
status: approved
approved: true
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"

approved-by: "Echo, after internal convergence review. External reviewer assurance unavailable."
review-convergence: "2026-11-27T03:40:25.173Z"
review-iterations: 4
review-completed-at: "2026-11-27T03:40:25.173Z"
review-report: "docs/specs/reports/project-registry-approved-anchors-convergence.md"
cross-model-review: "degraded-all-rounds"
cross-model-review-reason: "timeout"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 1
---

# Project registry alignment anchors

## Goal

A project session can recover its purpose from the project registry after a restart or context fold. The registry preserves the original owner message and the conversation, message ID, and time that establish its source.

## First pilot

Context Budget seeds its purpose from the Studio's original Telegram history. An authenticated operator session selects the source. The source text itself needs no separate approval. The caller supplies a source reference and the expected project version. The registry checks the project's unique active conversation binding and resolves the original text using the verified Telegram owner. The row must be an original, non-forwarded owner message and must match the source conversation, message ID, and time. The registry copies the complete stored message verbatim, preserving the adapter’s existing ingress normalization, and leaves the done and scope lists empty. Owner-words records help locate the original message.

If the source is missing or unverifiable, the writer returns a named conflict before changing the registry. Purpose-only initialization is for a project without a current anchor. A future operator approval request will cover agent-written done and scope entries. The reader returns the stored revision only for the exact active project binding. Rebinding clears the previous conversation's anchor while preserving the revision counter.

The Chief of Staff pilot requires a trusted lookup for original Mini history. Approved plan snapshots and ongoing owner-message collection are later work.

Operator selection copies the text into the project record, visible wherever the project record is already visible.

## Verification

- Verify exact text preservation across source and project conversations.
- Verify that missing history, stale writes, ambiguous binding, and attempts to replace an existing anchor are refused.
- Boot the production HTTP server and verify authentication and the missing-history response.
- Verify persistence through the registry's TaskFlow path without altering the project's current wait.
- Repeat the renderer lifecycle proof against the published source-backed registry revision.

A rollback can revert the writer and reader change. Existing project fields remain readable. The pilot is complete after both production source paths and their renderer checks pass.

## Decision points touched

- Operator authorization for selecting a source — invariant; basis: irreversible-consequence; evidence: installing conversation text as project context can expose it to another conversation.
- Original-message verification — invariant; basis: enumerable-domain; evidence: only historical rows matching the verified owner, non-forwarded status, conversation, ID and timestamp are eligible.
- Unique binding and current version — invariant; basis: enumerable-domain; evidence: a stale or ambiguous association has no unique project revision to update.
- Initial-purpose eligibility — invariant; basis: enumerable-domain; evidence: an existing anchor is preserved. This pilot returns a conflict for an existing anchor.

- Context lookup and rebinding — invariant; basis: enumerable-domain; evidence: the reader returns the record only for its active binding and a changed binding clears it.

## Multi-machine posture

The project registry remains responsible for stored state. The pilot admits a write only through the current registry writer and only if that writer can verify the source through its Telegram adapter. When original history is on another machine, the call returns a named conflict and leaves the registry intact. The local exact lookup inherits the Telegram adapter’s 16 MiB scan budget. A source beyond that budget is unavailable. Recovery in this pilot is qualified only on the Studio. A moved session without the same current registry record uses ordinary recovery until remote registry reads are qualified. Trusted remote history lookup is a dependency of the second pilot.

## Frontloaded Decisions

- Use operator-session authorization for selecting and disclosing an original source.
- The [Studio standing-summary pilot](studio-project-purpose-pilot.md) may display one preselected original message as advisory context after the verified operator directly authorizes that exact source, destination, and machine. The reviewed release records that exact authorization as a pinned grant. This grants no general selection capability and does not alter the operator-session requirement for writing confirmed registry state.
- Preserve exact message text. Reuse the adapter's exact bounded history lookup and reject sources outside the available local history.
- Use the existing active project binding and optimistic version checks. Restore the prior in-memory anchor if a legacy file write fails.
- This writer accepts one source reference for one project. Job and Projects topic 147616 owns the proposal and batch interfaces.

## Open questions

*(none)*

## Maturation plan

- **test-agent-live:** exercise exact-text recovery and failed source lookup on a disposable agent with fixture history.
- **dev-agent-live:** confirm the verified Context Budget source and run the renderer lifecycle on the Studio.
- **fleet:** expose the operator-authenticated storage path after verification. No project acquires an anchor until an operator designates a source or a reviewed batch applies one.
- **graduation criterion:** the exact saved purpose recovers across fresh start, restart and compaction for the Context Budget and Chief of Staff pilot conversations. Unverified sources and absent registry state retain ordinary recovery.
- **dark-window:** project records retain their current behavior before an operator selects a verified source.
- **ladder:** not applicable: no new runtime flag. The existing operator authorization and verified source requirements govern every registry write. The pilot steps above verify readiness before broader use.
