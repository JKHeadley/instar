# Side-Effects Review — Worktree removal runs in its own process, hourly

Spec: `docs/specs/reaper-removal-out-of-process.md` (converged in 6 rounds; approved by the Chief of Staff, msg 51cdd3bb, 2026-11-18 20:49 PT).

## Summary of the change

The agent-home worktree reaper's live removal moves off the server's main thread, into one niced, detached reclaim child that does both evaluation and removal. A new runner (`agentWorktreeReclaimRunner.ts`) supervises it, with:
- durable intent before spawn;
- ownership by process group;
- async `ps`;
- corroboration by run id;
- escalating kill;
- adoption after restart.

The child (`agentWorktreeReclaimMain.ts`) does:
- a temp-file plus `link()` lock;
- fsynced attempt rows;
- PR 3480's archive and final re-check;
- a lock check and a same-repository check;
- a rename into `.worktrees/.trash/<attemptId>` via the new `SafeFsExecutor.safeRenameDirSync`;
- `git -C <home> worktree prune`;
- a trash delete via the new `SafeFsExecutor.safeRmTreeInSubprocess`.

Leftover trash is cleaned within a 300 s budget, with retry rows. A closed-unmerged PR counts as merged only on an exact `headRefOid` match plus a matching `git ls-remote refs/pull/<n>/head`. The pass interval goes from 24 h to 1 h, with a run-once migration of the exact old default. Removal stays `dryRun: true`.

## Decision-point inventory

- **Whether a reap-eligible worktree is removed in a run.** Invariant, fail-closed. The child re-evaluates from scratch, then archives and re-checks, before the rename.
- **Whether a closed-unmerged PR counts as merged.** Invariant: an exact head match plus a matching PR-ref `ls-remote`.
- **Run cap, deadline, time-left and trash budget.** Judgment-candidates with deterministic floors, derived in the spec.
- **The new `worktreeTrashScope` guard option.** It is checked first and decides alone when given.

## 1. Over-block

Worktrees that are clean but whose PR was closed and whose head is no longer on GitHub's PR ref stay kept. So do worktrees of another repository (`other-repo`) and locked worktrees. All of these are intended. Checkouts with a real `node_modules` stay `work`, as today; that is the separate spec `reaper-node-modules-regenerable`.

## 2. Under-block

These residuals are accepted and stated in the spec:
- a writer that opens a file in the milliseconds between the final re-check and the rename;
- prune dropping a sibling entry in the microseconds before git writes its `initializing` lock;
- prune dropping entries whose folder is missing elsewhere, which `git worktree repair` re-links.

## 3. Level-of-abstraction fit

The work sits in the reaper's own runner and child, following the disk steward's runner pattern. The guard change is a narrow option in `SafeFsExecutor.guard()`. It does not touch the broad `isUnderAgentRuntimeState` carve-out; that hole is filed as fb-abdf2088-f27 and owned by Echo.

## 4. Signal vs authority compliance

Removal authority stays with the existing fail-closed evaluation, which the child repeats immediately before acting. No new brittle check gains blocking authority over anything but the reaper's own deletes. The guard option only narrows what the child may rename or delete.

## 4b. Judgment-point check (Judgment Within Floors standard)

The cap (20), deadline (900 s), time-left factor (5x the measured time) and trash budget (300 s) are derived from measurements:
- about 3 s per removal;
- about 123 eligible worktrees in the backlog;
- a link index bounded at 300 s.

Every limit fails safe: hitting it postpones work, never removes more.

## 5. Interactions

- **Disk steward:** its live deletes are its own caches; neither child touches the other's paths.
- **Walks:** `.trash` is skipped by the link index, `listWorktrees`, `InstarWorktreeManager`, `ScopeAccretionSweep` and `AgentWorktreeDetector`.
- **Breaker:** it reads the child's rows, deduplicated by attempt id.
- **Race guard:** it now also compares the live head commit, which a test showed was needed.
- **Audit trail:** the child's `cwd` is the agent home, so its audit lines land in the agent home's `.instar/audit`.

## 6. External surfaces

- **GitHub reads:** one `gh pr list --state closed` per pass (cached), plus one `git ls-remote` per closed-unmerged candidate. These are read-only calls, well under rate limits.
- **Report:** the route's report also comes from the child when live.
- **Notices:** no new operator notices.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No new operator surface. The awareness entry `worktree-reaper-background-reclaim` tells agents the reaper reclaims hourly in a background process, with removal off by default.

## 7. Multi-machine posture (Cross-Machine Coherence)

`machine-local-justification: hardware-bound-resource`. Each machine reclaims its own checkouts on its own disk, in its own child. There are no replicated state, notices or URLs.

## 8. Rollback cost

Revert the PR. With `dryRun: true` nothing is removed, and the migration only changes `reapIntervalMs` from exactly 24 h to 1 h, which a revert leaves harmless (hourly dry-run passes). `.trash/` is created only by live removal. If this is reverted after removal has been turned live, the reaper falls back to the old in-process removal on the main thread. In that case set `dryRun: true` again before reverting, or right after.

## Conclusion

Safe to ship with removal off. The live-removal decision stays with the Chief of Staff, with the hourly dry-run counts plus PR 3480's numbers.

## Second-pass review (if required)

Required (removal, guard). An independent reviewer read the diff (2026-11-18 22:21 PT) and **concurred**. Notes:
- step order matches spec §1-2;
- the guard opens nothing beyond the trash root and the evaluated sources;
- live passes do no synchronous git, lsof or ps;
- dry-run is unchanged except that the closed-PR rule now also feeds the report;
- the migration runs once and touches only the exact old default.

Its nits are addressed: the migration's placement was fixed and the marker's purpose documented, and §8 now names the revert-while-live case. Two keep exits after the archive leave the gate records in the archive, so nothing is lost.

## Evidence pointers

- Spec, report and ELI16 under `docs/specs/`.
- Measurements in the spec's problem statement.
- Unit tests: `tests/unit/SafeFsExecutor-worktreeTrashScope.test.ts`, `agent-worktree-reclaim-{child,runner,git}.test.ts` and `agent-worktree-reaper-out-of-process.test.ts`.
- Integration test: `tests/integration/agent-worktree-reclaim-live.test.ts`.

## Class-Closure Declaration (display-only mirror)

Class: unbounded-self-action. Closure: this change BOUNDS the agent's own deletes. There is one child at a time, capped at 20 removals and a 900 s deadline, each removal fail-closed, and removal off by default.
