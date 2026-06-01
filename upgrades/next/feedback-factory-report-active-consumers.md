## What Changed

**The feedback-factory's merge-candidate query and operator-report partitioner no
longer go blind when a cluster carries the canonical v2 status spelling.** #651 added
the canonical status-normalization primitives and applied them to the parity
comparator, but two *internal* call-sites still keyed off the legacy v1 status words.
The active-cluster query (the merge-candidate set) treated only the literal
`resolved` as terminal, and the operator-report partitioner matched only the literals
`open` and `fixed`. Because live clusters are increasingly born and resolved in the
canonical v2 vocabulary (`new`, `fix_applied`, `closed`, `verified`, …), those
raw-literal checks silently misbehaved: every terminal v2 cluster (`closed`,
`verified`, `wontfix`, `duplicate`, `chronic_escalated`, `legacy_closed`) was kept
forever as an active merge candidate, and v2 `new` / `fix_applied` clusters never
appeared in the "new issues" / "fixed" sections of the report.

The fix routes both call-sites through the canonical primitives merged in #651
(`normalizeStatus` / `isTerminalStatus` in `transitions.ts`) — no new module, one
owner for the vocabulary. The active set is now "normalized status not terminal"; the
report partitions on the normalized status (`open` ≡ `new`, `fixed` → `fix_applied`).
Legacy and canonical spellings are treated identically.

## What to Tell Your User

Nothing to configure, and nothing changes for any current capability. This is
internal plumbing for the in-progress feedback-factory migration. Two internal checks
that decide which feedback clusters are still active and which appear in the operator
digest were keyed to the old status words; they now understand the new status words
too, so clusters are no longer wrongly held open forever and the digest no longer
drops freshly opened or fixed items. No routes, jobs, or user-facing behavior change.

## Summary of New Capabilities

- `FeedbackStore.getActiveClusters` (`src/feedback-factory/store/FeedbackStore.ts`) now
  excludes a cluster when its NORMALIZED status is terminal (`!isTerminalStatus(status)`),
  instead of the raw `status !== 'resolved'` check that stranded every canonical
  terminal cluster as a perpetual merge candidate.
- `partitionClustersForReport` (`src/feedback-factory/processor/reportPartition.ts`) now
  normalizes before bucketing: the open partition is canonical `new` (v1 `open` projects
  to it), and the fixed partition is canonical `fix_applied`. A mixed v1/v2 batch
  partitions identically.
- Both reuse the `normalizeStatus` / `isTerminalStatus` primitives from `transitions.ts`
  (the ones merged in #651) — no duplicate vocabulary module.

## Evidence

The two checks previously keyed off raw v1 literals. Behavior before vs after,
confirmed by both-sides-of-boundary unit tests:

```
getActiveClusters, cluster.status = "closed" (canonical terminal):
  BEFORE (status !== 'resolved'):    kept ACTIVE forever  ← perpetual merge-candidate bug
  AFTER  (!isTerminalStatus):        excluded (terminal)

reportPartition, cluster.status = "new" / "fix_applied" (canonical v2):
  BEFORE (=== 'open' / === 'fixed'): never matched → dropped from the report
  AFTER  (normalizeStatus ...):      surfaced in the open / fixed partitions
```

Verified across the full feedback-factory suite: 165 unit + integration tests green
(incl. new `store.test.ts` terminal / non-terminal active-set tests and
`reportPartition.test.ts` v1/v2 mixed-batch tests), `tsc` clean.
