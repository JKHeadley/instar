# Side-Effects Review — topic-workspace cap evicts idle records

**Version / slug:** `worktree-binding-cap-evict-idle`
**Date:** `2026-11-03`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1, no gate/session-lifecycle authority change; see below)`

## Summary of the change

`src/core/WorktreeManager.ts` `createBinding()`: at `MAX_ACTIVE_BINDINGS` (30), after the existing merged/abandoned eviction finds nothing, it evicts the binding with the oldest `createdAt` whose worktree has no live session lock (`isLockLive`), and appends a `binding-evicted-idle` history event. Only the in-memory record (and the saved bindings file on the next save) is removed; the worktree directory and branch stay. A later `resolve()` for that topic re-creates the record and adopts the existing directory (the existing "Adopt existing if .git is valid" path). When every binding has a live lock, it still throws, and the message now says `all held by live sessions`.

Why: no code anywhere sets a binding's status to `merged` or `abandoned`, so the original eviction never fires. On Echo, 30 bindings dating from 2026-10-28 were all `active`, and `POST /sessions/spawn` for two new operator-requested topics failed with `Max active bindings (30) reached`.

Tier 1: one function, about 25 lines, fully reverted by a revert, no persisted-format change. Tests: `tests/unit/WorktreeManager-binding-cap.test.ts` (3 cases: evict the oldest idle, re-adopt an evicted topic's existing worktree, still refuse when all are live), proven to fail on the old code (2 of 3 fail), and the 12 existing `WorktreeManager.test.ts` cases pass.

## 1. Over-block
None new. The old code refused every spawn at the cap. The new code refuses only when all 30 are live.

## 2. Under-block
An idle record can be dropped while its topic's session is merely between turns with no lock held. That topic gets its record back on its next spawn, adopting the same worktree. Nothing in the worktree is lost.

## 3. Level-of-abstraction fit
This is the cap's own eviction step, which already existed but could never fire. The fix is at the right layer.

## 4. Signal vs authority compliance
No decision about agent behaviour or information flow. A bookkeeping eviction decided on a deterministic fact (a live lock).

## 5. Interactions
`reconcile()` treats a worktree with no binding as a filesystem/git-only row; an evicted record's directory therefore shows up there as unbound until reused, which is accurate. The lock map is untouched. The history log gains one event kind.

## 6. External surfaces
The error message text changes from `Max active bindings (30) reached` to `... reached, all held by live sessions`.

## 7. Multi-machine posture
Machine-local by design: bindings, worktrees and locks are per machine. A lock from another machine counts as live (`isLockLive` cannot verify a remote PID), so a record a peer may be using is never evicted.

## 8. Rollback cost
Revert. Any records evicted under the fix are simply re-created on their topic's next spawn.
