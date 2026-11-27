# Side-Effects Review — Work front doors: the Chief of Staff / board / graph links as one tested module

**Version / slug:** `work-front-doors-graph-links`
**Date:** `2026-11-16`
**Author:** `Echo`
**Second-pass reviewer:** `not required (pure extraction of reviewed code, behaviour unchanged, plus tests)`

## Summary of the change
PR 3242 put two read-only adapters inline in AgentServer (each open card → its project's conversation; each bound Chief of Staff project → a suggestion source), each with its own copy of the Chief of Staff key → conversation-graph ref mapping, and neither had a direct test (the proposed-cards list has no e2e yet: a booted test server has no conversation inventory). This moves them into `src/core/workFrontDoorsGraph.ts` (`cosConversationRef`, `cardPlacementsFromBoard`, `projectSuggestionSources`), AgentServer calls them, and `tests/unit/work-front-doors-graph.test.ts` covers the mapping (telegram needs the chat id; app; Slack and malformed skipped), the card filter (done/archived/removed/uncreated/projectless/unmapped drop off) and the project sources (graph key, children, unmapped skipped). Behaviour is unchanged.

## Decision-point inventory
None.

## 1-2. Over-block / Under-block
No change from PR 3242 (reviewed there).

## 3. Level-of-abstraction fit
Pure functions in core, wired in AgentServer: testable without a booted server.

## 4. Signal vs authority compliance
Read-only.

## 5. Interactions
Same inputs and outputs as the inline code; one shared key mapping instead of two.

## 6. External surfaces / 6b. Operator surface
None changed.

## 7. Multi-machine posture
Unchanged (derived from each machine's replicas).

## 8. Rollback cost
Revert the commit.

## Evidence
`tests/unit/work-front-doors-graph.test.ts`; the existing `conversation-graph-suggestions` and `conversation-graph-card-proposed` tests still pass (38).
