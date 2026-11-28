# Side-Effects Review — Topic worktrees: stop the stale locks, and measure what is safely reclaimable

**Version / slug:** `topic-worktree-reclaim`
**Date:** `2026-11-18`
**Author:** `echo (echo-machine-stewardship)`
**Second-pass reviewer:** `independent subagent`

## Summary of the change

Spec: `docs/specs/topic-worktree-reclaim.md`. It converged in 6 rounds and was approved by the Chief of Staff (msg 5ecf7d6f) with three fold-ins, all applied. **Nothing in this change removes a worktree.**

- **A. Locks.**
  - `WorktreeManager.releaseForSession(sessionId)` runs on `sessionComplete` and `sessionKilled`, but only when the session's tmux session is gone.
  - At start, `releaseOrphanedLocks()` releases a lock only when its session has no `running`/`starting` record AND no live tmux pane is working inside the tree (`SessionManager.listAllPaneCwds()`, one `tmux list-panes -a` read).
  - These all keep the lock: an unreadable or unparsable record, a failed tmux read, or an unlink error other than `ENOENT`.
- **B. The running reaper.**
  - One link-root list now spans `<home>/.worktrees` and `<stateDir>/worktrees`. `owner()` maps targets in either folder, and the agent home is passed in explicitly.
  - `isInUse` reads the index lock of a linked worktree through its `.git` `gitdir:` file.
  - The merged-PR lookup keeps only PRs merged into the base branch, whose name comes from the resolved base ref.
  - The removal catch emits `'reclaim-failed'` instead of `'error'`.
- **C. Dependency copies.** `fastCopyDeps` writes `node_modules/.instar-deps-copy`.
- **D. Measurement.** `topicWorktreeMeasure.ts` runs in the disk-steward child, after the whole-disk walk.
  - It is read-only.
  - It is gated by `monitoring.diskSteward.topicWorktreeMeasure` through `resolveDevAgentGate`: live on dev agents, dark on the fleet.
  - It covers provenance (binding history, this machine), in-use, creating, residue, merged, the buckets, and the audit table.
  - Its deadline is the run deadline minus 60 s.
  - It writes rows per entry, plus false-eligibility rows.
  - The result reaches the disk report as a `topicWorktrees` row.

## Decision-point inventory

See the spec's table. Every point is invariant, and D is dark on the fleet.

## 1. Over-block

A: a lock is kept whenever anything is unknown. That is today's behaviour.

## 2. Under-block

These known limits are stated in the spec and accepted by the Chief of Staff:
- the overlapping-server spawn race, now narrowed by the pane check;
- the inherited 30 s per-call timeouts;
- links nested deeper than depth 3.

## 3. Level-of-abstraction fit

The change reuses WorktreeManager, the reaper deps, and the disk-steward child and its report.

## 4. Signal vs authority compliance

A only removes lock files that serve no running session. B only tightens existing checks. C writes a marker. D measures. None of them removes a worktree.

## 5. Interactions

- B's added links and its base filter can only add "keep" verdicts to the running reaper.
- The `'reclaim-failed'` rename moves two existing tests.
- D runs after the whole-disk walk, so that walk keeps its budget.
- A's release on end is skipped while tmux still shows the session.

## 6. External surfaces

- The disk report gains a line.
- Two local-state files: `topic-worktree-plan.json` and `topic-worktree-false-eligibility.jsonl`.
- The config key `monitoring.diskSteward.topicWorktreeMeasure` (optional; absent means the dev-agent gate decides).
- A new public method: `SessionManager.listAllPaneCwds()`.

## 6b. Operator-surface quality

The report line reads, for example: "Conversation worktrees provably safe to remove: N (X GB); more if library copies are accepted… Nothing is removed yet."

## 7. Multi-machine posture

Machine-local: `machine-local-justification: hardware-bound-resource`. The report row is unified through `disk-steward?scope=pool`.

## 8. Rollback cost

- A, B, C: revert.
- D: switch off `monitoring.diskSteward.topicWorktreeMeasure`, or revert.

## Conclusion

Stops the lock leak, fixes three latent reaper bugs, and measures phase 2's evidence. Phase 2 is CMT-1958.

## Maturation ladder

D has its own ladder entry, `monitoring.diskSteward.topicWorktreeMeasure` in `src/data/feature-ladders.json`. It is dev-gated, `tracking: needed`, and owned under CMT-1958. It graduates on its own numbers: runs with zero errors on the development agent, then 30 days with zero false eligibility before the fleet rung. A and B are always on. They only release locks whose session has ended, or add reasons to keep a worktree, so neither has a flag.

## Second-pass review (if required)

**Round 1 (independent subagent, 2026-11-18 11:15 PT): concern raised.** Nothing removes a worktree and no path releases a live session's lock; the concerns and their fixes:

1. **D did not hold its deadline on every step.** The link walk used its 300 s default, and merged/in-use checks and `gh` used fixed 30 s timeouts, so an overrun could reach the server's kill time and lose the whole disk-steward result. Fixed: one `left()` clock caps every git call (refuses under 1 s), a new `makeCappedRunGh(left)` caps every `gh` call, and the link walk gets `timeoutMs = left()`. All three are passed into the reaper deps D builds.
2. **Command-line check missed `.instar/worktrees/<slug>`.** Fixed: a second pattern for that path; test added.
3. **A null WorktreeManager machine id widened provenance to every machine.** Fixed: no id means no provenance (`provenance-unreadable`); test added.
4. **Audit order put an exact-OID squash merge under "could not verify".** Fixed: ancestor, then exact-OID merged PR (corroborated by the merge commit), then patch-equivalence (could not verify), else disagrees.
5. **Missing tests.** Added: squash with merge commit present (agrees) and absent (could not verify), a PR merged into another branch (unmerged), unreadable sessions directory, null machine id, the `.instar/worktrees` command line, and a removal failure with no listener (proves `'reclaim-failed'` cannot throw). The server-wiring paths (end-event keep-while-tmux-alive, the start-time call site, trailer signing after a restart) stay covered by the unit tests of the methods they call; the live proof is the test-agent rung in the maturation plan.
6. **Minor, fixed:** the `.worktrees` measurement in the disk-steward child now passes the shared link roots; pane folders compare by `realpath`; one unreadable session id keeps its lock instead of aborting the whole start-time release; the `machineId` getter moved above `releaseForSession`'s doc comment. Kept reasons `deps-lock-differs`, `detached` and `eval-error` are named here as the measurement's own reasons (more specific than the spec's `unmarked-deps`).


## Evidence pointers

- `tests/unit/topic-worktree-reclaim-locks.test.ts`: release on end, a failed unlink keeps the lock, orphan release with records and with a live pane, cross-folder link, linked-worktree index lock.
- `tests/unit/topic-worktree-measure.test.ts`: every bucket and reason on a real repo, a passed deadline, an unparsable record, another machine's history, residue.
- `tests/unit/agent-worktree-reaper.test.ts`: the base filter, the fixtures, and a wrong-base PR.

**Round 2 (same reviewer, 11:20 PT): concern raised.** The disk-steward child still passed the uncapped `defaultRunGh`, which overrode D's capped runner, so `gh` calls could still run 30 s each past the deadline. Fixed: the child no longer passes a runner; D always builds `makeCappedRunGh(left)` in production (an injected runner is for tests only). The reviewer verified every git call, the link walk and the audit order, and found no regression to the running reaper. Noted, accepted: the `lsof`/`ps` scans keep their fixed 15 s timeouts (at most 30 s together, inside the 60 s reserve).

**Round 3: Concur with the review** (11:21 PT): the child no longer passes a runner; `measureTopicWorktrees` has one production caller; tsc clean.

**Follow-up commit (11:50 PT):** D's flag is now listed in `DEV_GATED_FEATURES` (`topicWorktreeMeasure`), so the both-sides wiring test covers it: live on dev, dark on the fleet. A second-pass review on a sibling change noticed the missing registry entry.

