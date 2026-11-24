# Side-Effects Review — Internal Work Owner Surfaces

**Version / slug:** internal-work-owner-surfaces
**Date:** 2026-11-23
**Author:** Echo
**Second-pass reviewer:** Independent attention, conversation and authority reviewers; source concurrence recorded separately from complete verification.

## Summary of the change

Tier 1, reversible repair of existing read projections and empty conversation creation. A shared structured internal-card classification excludes routine agent work from owner discovery, counts and operational summaries. The explicit agent board retains inspection. Multiple bounded review passes were justified because the same defect crossed flat lists, pins, search, unread, Projects, source-linked cards and the optional hierarchy. Exact file/line totals and commit attempts belong in the final publication handoff. No policy adapter or execution authority change is included.

## Decision-point inventory

- WorkCardStore classification and lanes: modify display classification using recorded creator/requester/carrier/outward/question/confirmation facts. No title or age heuristic.
- WorkBoard views, routes, source-card reads and pickup summaries: modify projection before totals, cuts and hashes; add deliberate internal-only read.
- WorkBoardRuntime materialization: modify eager creation; permit execution history only after existing note admission or actual dispatch.
- App store, conversation routes, pins, search, unread and enabled hierarchy: modify owner presentation using the same hidden keys; retain direct history and replication inventory.
- Existing start policy, proof checks, evidence/claim/note admission, person permissions and owner graph correction scope: pass through unchanged.

## 1. Over-block

A requester-backed card is never classified as pure internal. Outward work, person carriers/waiters/questions, owner-confirmed criteria and pending real confirmation remain person-facing. A future owner-confirmed criterion is deliberately conservative because the owner has an eventual certification role. Unavailable classification returns an explicit unavailable read; it does not delete history or silently succeed with no work. Unknown metadata is not guessed from titles. Older clients retain absent-field compatibility.

## 2. Under-block

Legacy empty chats already exist, so suppressing creation alone was insufficient. Shared discovery filtering covers those rows and old pins, pooled rows, keyword/meaning hits, triggering unread fallback, source-linked lists and retained graph nodes. A legacy peer unread hint cannot certify owner unread; its uncertainty is explicit. Older installed clients/servers may still display old behavior until updated. Physical phone and keyboard behavior is not established by the sample-data preview.

## 3. Level-of-abstraction fit

The classification uses durable card facts at the service fold and is reused by projections. It does not ask each renderer to infer intent. Worker history, replication and direct storage remain separate from human discovery. No parallel policy gate is introduced.

## 4. Signal vs authority compliance

This is an enumerable presentation invariant, not execution authority. Structured person obligations preserve existing owner action surfaces. The change neither grants approval nor decides that work may execute. Existing policy/proof gates remain authoritative; hidden not-started work still cannot record notes or dispatch through those gates. No brittle language detector holds authority.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The owner requested a specific deterministic presentation boundary. The predicate enumerates recorded provenance and obligations; it does not weigh ambiguous prose, urgency or liveness. Quiet, capacity and parked state alone do not establish a person decision.

## 5. Interaction audit

Shadowing: apply visibility before count/cut/search/pin presentation, preserving actual person authorization checks. Double-fire: read routes never create history; dispatch and allowed notes materialize idempotently. Races: late-bound runtime absence raises unavailable instead of an empty hidden set; asynchronous pool reads propagate named visibility failures. Durable note pointers keep history available after draining/restart. Feedback loops: removing internal Needs rows does not alter workability or policy; no automatic policy change is added.

## 6. External surfaces

Additive JSON fields agentInternal, conversationAvailable, ownerProjectionVersion and view describe the read contract. The explicit agent view is phone-completable through a visible dashboard link and the existing signed mobile board read. No external service write or stored-data migration occurs. Native received the exact typed semantics but waits for committed/tested head and separate live readiness. No new approval control is introduced.

## 6b. Operator-surface quality

Primary content remains plain language. Internal not-started/withdrawn states describe agent status rather than asking the owner to approve. The agent view has a clear title/back link. Unavailable chat links do not mount an empty history. No new destructive control is added. Four normal Chrome invented-data cases at390 and1280 pixels show the appropriate owner/agent cards and dialogs, no sideways overflow, no application writes or JavaScript errors. This is scoped source-preview evidence, not broad design or installed-phone approval.

## 7. Multi-machine posture

Proxied-on-read: local projections derive from replicated work-card records and pooled conversation reads. Legacy peer pages are filtered against local classification after merge; short/empty pages retain nextCursor. Version1 peers may supply owner unread hints; older hints report uncertainty. History and graph inventories are retained for replication. There are no new user-facing notices or machine-local status endpoints. Existing deep links remain agent routes; no host-specific link is introduced.

## 8. Rollback cost

Revert the code and ship a patch. No schema or persisted record is rewritten or deleted. Existing internal history remains available in storage. A rollback restores old owner clutter until corrected again; deferred internal history may be materialized by old boot logic. Approval state remains unchanged.

## Conclusion

The repair is reviewable as a read-projection and lazy-materialization change. Focused tests and source-preview evidence support its boundaries. Complete suites and publication go through Chief and throughput; no release or live policy claim is made. The missing trust-journey board-policy adapter is a separately recorded follow-up because its proof representation needs its own authority review.

## Second-pass review

**Reviewer:** /root/protected_owner_surface_second_pass

**Independent read of the artifact: concur**

The independent reviewer read this artifact and the protected audit at `docs/audits/internal-work-owner-surfaces.md` on `b846a18daeec12ff5dc07ff50e58a3e03ea592d3` in full. The reviewer checked the classifier and lane branches, lazy history creation, the explicit agent board view, pooled discovery and pins, and the boot and board-disabled tests. The two successor commits changed test fixtures only.

The reviewer confirmed that the source preserves existing approval authority and stored history while filtering internal work from owner-facing discovery. Genuine owner requests and questions remain represented. The read-only convergence validator confirmed six audit rounds, closed findings, and a final round with zero new findings. The reviewer inspected stored focused results and did not rerun the full suites or witness prior review rounds. The concurrence covers this protected audit and its source evidence. It does not certify an installed release.
