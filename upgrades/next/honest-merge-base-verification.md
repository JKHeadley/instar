<!-- bump: patch -->

## What Changed

**The projects `/advance` merge-base check no longer reports "not on main" when it was simply not
allowed to look.** Found 2026-07-25 recording PR #1641 as merged — the step had never once
succeeded on a dogfooding agent.

- **The read now declares itself a read.** `gitMergeBaseIsAncestor` called
  `SafeGitExecutor.readSync` without `sourceTreeReadOk: true`. A project's `targetRepoPath` IS an
  instar source tree on a dogfooding agent, so `SourceTreeGuard` refused the query every time.
  `merge-base` is already in `SOURCE_TREE_READ_TIER_VERBS` — the permission existed and was never
  requested.
- **A refusal is no longer translated into a fact (the load-bearing half).** The old
  `catch { return false }` turned a guard refusal, a missing binary, a bad revision (exit 128) and
  a timeout into the same `false`, which the validator surfaced as `MERGE_COMMIT_UNREACHABLE` —
  "this merge is not on main" — about a merge that demonstrably was. Now ONLY git's documented exit
  status 1 means "not an ancestor"; every other failure is rethrown and
  `StageTransitionValidator` returns a new distinct code **`MERGE_BASE_UNVERIFIABLE`** carrying the
  underlying cause.

Nothing is loosened: a genuine non-ancestor still fails with `MERGE_COMMIT_UNREACHABLE` (asserted
in its own test so the boundary is not blurred in the other direction).

Reproduced under the server's exact environment before fixing: real merge SHA without the flag →
`SourceTreeGuardError`; with the flag → ancestor TRUE; a real commit not on main → status 1; a
nonexistent SHA → status 128 (unanswerable, which the old code also called a negative).

## What to Tell Your User

If you use projects to track work, marking an item as merged should now succeed where it previously
failed with a confusing "merge commit is not reachable from main" — especially on an agent whose
target repository is the instar source tree. If the check genuinely cannot run, you now get "could
not verify" with the reason instead of a wrong factual claim.

## Summary of New Capabilities

- `MERGE_BASE_UNVERIFIABLE` — a new stage-transition refusal code distinguishing "could not check"
  from "checked and it is not there". The reason string carries the underlying cause.

## Known Gap (measured, tracked)

This is the SECOND instance of this bug class (the first, in May, hit failure-learning's git reads;
its ratchet was scoped to that subsystem only). Measured exposure: **34 of 46**
`SafeGitExecutor.readSync` callsites in `src/` do not pass `sourceTreeReadOk: true`. Most are
legitimate (targets that are not the instar source tree). They are deliberately NOT swept here —
flagging 34 callsites blind would relax a safety guard on evidence nobody has. The follow-up is a
per-callsite audit then a repo-wide default-plus-declared-exception ratchet. <!-- tracked: CMT-1035 -->

## Evidence

- `tests/unit/StageTransitionValidator.test.ts` — a throwing helper yields
  `MERGE_BASE_UNVERIFIABLE`; a helper returning false still yields `MERGE_COMMIT_UNREACHABLE`.
- `tests/unit/projects-advance-mergebase-wiring.test.ts` — static wiring: the callsite carries
  `sourceTreeReadOk: true`, the helper tests `status === 1` and rethrows otherwise, the bare
  `catch { return false }` shape cannot reappear, and the new code comes from a `catch`. Static
  rather than mocked because mocking `SafeGitExecutor` is how the existing tests masked this gap.
