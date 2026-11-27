# Side-Effects Review — Work front doors, stage 2b step 2: cards proposed under their project

**Version / slug:** `work-front-doors-stage2b-cards`
**Date:** `2026-11-16`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Spec docs/specs/work-front-doors.md §3.2: a card's conversation sits under the effort that holds its project's conversation. Until the `card-record` graph authority exists (step 4, schema bump, fleet-gated), "the placement is a proposal shown from the card record, labelled as proposed".
- `GraphReadSource.cardPlacements?()` (optional port): each open card's own conversation and its project's conversation (from the card's `projectKey`).
- `ConversationGraphReadModel.node()` for an effort adds `proposed: { items, by: 'card-record' }` (at most 50): card conversations with no placement of their own whose project conversation is placed directly in this effort, through the same projection the viewer filter already ran. Nothing is written; children and their cursor snapshots are unchanged.
- `ConversationGraphRuntimeReadSource` takes the port from the surface options (a throwing source proposes nothing); `ConversationGraphSurface` passes it; `AgentServer` builds it from the work board: created cards with a `projectKey`, skipping done, archived and removed cards (the "done card leaves the default list" rule for this list), Telegram and app project keys.
- Console: `nodeModel` reads `proposed` (a malformed row is dropped from this optional list only); a project's page shows "Cards for this project" with each row marked "Proposed" and one line saying a move makes it part of the project for good.

## Decision-point inventory
None. Read-only; no authority. The owner's existing Move is how a proposal becomes a placement.

## 1. Over-block
A Slack project key is not proposed (no conversation ref for it yet). A card conversation placed by the owner anywhere is never proposed (owner placement wins, spec §3.2 rule 1).

## 2. Under-block
Only effort pages show proposals; the overview and All lists do not mark proposed cards (2b step 2 scope). The "done card leaves the default conversation list" half of §3.2 applies here to the proposed list only; the default list is unchanged in this step (tracked in stage2b-plan.md step 3).

## 3. Level-of-abstraction fit
In the read model, behind the viewer filter, through an optional source port: the same place every other graph read is shaped.

## 4. Signal vs authority compliance
Read-only display; no blocking or writing (docs/signal-vs-authority.md).

## 5. Interactions
- `graph.parentOf` decides both "the card is unplaced" and "the project sits here", so a later owner move of either updates the page on the next read.
- The work board read is in-process (`svc.view`); 50-item cap per page.

## 6. External surfaces
GET /conversation-graph/nodes/:effort gains an optional `proposed` field; older clients ignore it.

## 6b. Operator-surface quality
1. The page still leads with the project's own content; the proposed section follows its conversations.
2. No internals: card conversation titles and the word "Proposed".
3. Nothing destructive here.
4. Phone width: the rows reuse the existing conversation row layout. Not yet seen with real cards: checked on Echo after an owner accepts a project (the read needs a real effort).

## 7. Multi-machine posture
Proxied-on-read by composition: graph placements replicate through the graph; card records replicate through the work-board store; every machine derives the same proposals from its own replicas.

## 8. Rollback cost
Revert the commit; nothing is stored.

## Evidence
- Unit: `tests/unit/conversation-graph-card-proposed.test.ts` (proposed under the project's effort only; owner placement wins; project in no effort proposes nothing; a card the viewer may not see is left out; no source leaves the page unchanged), `tests/unit/console-conversation-suggestions.test.ts` (nodeModel reads and defaults the list). 123 Conversations tests pass.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Opus 5.5). **Independent read: concern.**
1. Privacy: the project end of the link was not checked against the viewer (only the card end and the effort), so a viewer who could see the effort and the card but not the project conversation would learn it sits there.
2. Card ownership is not consulted: every open card on the board is passed; safe only because the hierarchy read is owner-only in this version, which the note did not say.
3. A failed card read returned an empty list silently (indistinguishable from no cards).
4-6. Correctness, cursors/snapshots, AgentServer filter and console: checked fine.
7. The note missed 1-3, and the "not yet seen with real cards" needs a tracked follow-up.

### Resolution (author)
- 1: `projection.has(cp.project)` is required before anything is proposed. Unit test: a viewer who may not see the project conversation gets no `proposed` field.
- 2: Stated: the hierarchy routes answer `hierarchy-owner-only` to anyone but the owner (seen live on the throwaway, 2026-11-16 07:55), so only the owner ever reads proposals, and the owner may see every card. When the hierarchy opens to team viewers (stage 2's member/guest work, plan step 2e), the card source must filter by each card's audience before this port is used for them; recorded in .instar/lanes/work-front-doors-1114/stage2b-plan.md.
- 3: a failed card read reports a `Conversations.proposedCards` degradation and proposes nothing that read.
- 7: the real-card look is tracked under CMT-1841 (plan: after the owner accepts a project on Echo, check a project page with a card at both sizes).

**Re-check after fixes: concur** (same reviewer): the project end is checked before anything is proposed (new test hides only the project), the owner-only assumption is stated with its evidence, a failed card read files a degradation, and the real-card look is tracked under CMT-1841.
