# Side-effects review — card source backlink

## Summary and decision-point inventory
Approved work-front-doors stage2b2 requires a card's From link. Work-model now formats existing viewer-filtered source data into the signed Chats route. Chats accepts a message target and searches existing history. No card, graph placement, approval or audience is changed.

## 1. Over-block
Only existing supported conversation references and nonempty message identifiers of at most200 characters are linkable as exact messages, matching the source schema. A valid conversation with an unusable message id remains linked with an explicit explanation. Missing source shows no inference about missing history.

## 2. Under-block
A source link is navigation, not proof that a message remains available. Missing rows are described as absent from available history. Source data may outlive retention; the existing signed reader remains the access boundary.

## 3. Level-of-abstraction fit
This is read-only navigation through existing services, not a second conversation store. No new server endpoint or inferred graph relationship.

## 4. Signal vs authority compliance
No authority is added. Parsed references and exact identities select a read; the existing device signature and route access checks decide what can be read. See docs/signal-vs-authority.md.

## 4b. Judgment-point check
No new static heuristic at a competing-signals judgment point. Exact message identity, stale-request generations and cursor progress are enumerable navigation invariants.

## 5. Interactions
The initial history load completes before source search. Same-conversation target changes keep the composer mounted. A per-search generation discards superseded results; per-load sequencing protects cursor application and scroll restoration. Explicit pin/manual navigation pauses source search. A repeated cursor stops the batch, but newly returned target content is checked first. Existing pin behavior remains covered by its tests.

## 6. External surfaces
Console Work sheets and Chats gain read-only navigation. Source is already withheld from non-owner/non-agent card reads, and removed cards return before source rendering. All content uses safe element text. No outbound notification or mutation is introduced. The native app source interface stays with its assigned owner and is not claimed delivered here.

## 6b. Operator-surface quality
1. The From link appears in the open card before the need and completion detail; the original message is highlighted on arrival.
2. Labels say Original message or Original conversation. IDs stay in navigation parameters; the waiting conversation heading is generic until the real title arrives.
3. This adds no destructive action. Existing destructive card actions remain below source navigation; existing chat menu styling is unchanged.
4. Chromium at390 and1280 shows readable labels and no horizontal overflow. The source link opens the exact older message in both widths. Tests cover visible failure/exhaustion/continuation states and preserved drafts.

## 7. Multi-machine posture
Proxied-on-read: reuse existing pool-scoped history endpoints, existing signed browser identity and existing source identifiers. Links are origin-relative and contain no machine hostname. No new durable state, notices, /status, /health, /capabilities or /channels answer.

## 8. Rollback cost
Revert the frontend and awareness changes. Stored card sources and conversation history remain unchanged. Old clients ignore the message target and can still open the conversation. No migration or cleanup is required.

## Verification
Model and real signed-reader page tests cover exact IDs, malformed input, older history, explicit continuation, exhaustion, transport failure, unchanged cursors, stale navigation, drafts and access refusal. Chromium fixture checks are browser evidence, not a claim of real iPhone or production proof. Full-suite verification and rollout belong to throughput.
