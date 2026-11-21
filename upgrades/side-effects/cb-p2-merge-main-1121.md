# Side-Effects Review — Combined Phase 2 batch: merge of main on 2026-11-21

**Version / slug:** `cb-p2-merge-main-1121`
**Date:** `2026-11-21`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** independent subagent (see the end of this file)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §16, maturation plan
**Part of:** #3543

## Summary of the change

Merge commit 63097deb7 brings main (7be40c820) into the reviewed Phase 2 batch (4dfd67da1). One conflict, in `src/commands/server.ts`: main added the `isOwnerUnroutable` dependency to the single-line `new AgentServer({...})` construction, and the batch's new shadow fold runner block sits directly after that line. The resolution takes main's constructor line and keeps the batch's shadow fold runner block unchanged. Nothing else was authored by hand. This trace re-binds the independent review to the merged head, because a merge from main makes the earlier trace stale.

## Decision-point inventory
No new decision point. The merge changes no reviewed Phase 2 behavior.

## 1. Over-block
None.

## 2. Under-block
None.

## 3. Level-of-abstraction fit
Not applicable: a mechanical merge resolution.

## 4. Signal vs authority compliance
Unchanged from the batch's earlier reviews.

## 5. Interactions
`isOwnerUnroutable` is main's own wiring; it is passed exactly as main passes it.

## 6. External surfaces
None added.

## 7. Multi-machine posture
Unchanged.

## 8. Rollback cost
Reverting the PR reverts the batch; the merge adds nothing of its own.

## Second-pass review

**Reviewer:** independent read-only subagent (Opus 5.5), 2026-11-21

Verdict: CONCUR.

- Constructor fields: split by bracket depth, the resolved line at `src/commands/server.ts:36524` holds the union of both sides, 272 fields, none duplicated or dropped. The batch did not change that line; the conflict came from the adjacent shadow fold runner block, which `git show --remerge-diff` shows unchanged.
- No conflict markers were added. Markers in `tests/e2e/sync-edge-cases.test.ts` and `tests/unit/agent-robustness.test.ts` already exist at the merge base and in both parents.
- `_isOwnerUnroutable` is declared at `src/commands/server.ts:1587`; `AgentServer` accepts `isOwnerUnroutable` at `src/server/AgentServer.ts:1655`.
- For every other file both sides touched, the merged change equals the branch's change by per-file patch-id; for `server.ts` the added and removed lines are identical to the branch's.
- `npx tsc --noEmit -p .` exits 0 at 63097deb7.

No problems found.
