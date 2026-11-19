# Convergence Report: Worktree removal runs in its own process, on a cadence that keeps up with creation

## Cross-model review: codex-cli:gpt-6-astra

The GPT-tier review ran in all six rounds, through the codex CLI with model gpt-6-astra. Each round also had a clean-door Claude read (claude-code, claude-opus-5-5). That is a second read, not a cross-model opinion.

An internal reviewer checked every version against the code: `AgentWorktreeReaper.ts`, `agentWorktreeGit.ts`, `agentWorktreeEvaluationJob.ts`, `diskSteward/pruneRunner.ts`, `SafeFsExecutor.ts`, `SafeGitExecutor.ts` and `SourceTreeGuard.ts`. It also confirmed the round-6 fixes after the cap.

The Standards-Conformance Gate ran in rounds 1, 2 and 4. In round 4 the server was restarting for an install, and it ran once the server was back.

## ELI10 Overview

The agent makes about 80 working copies of its own code a day. A cleanup tool would remove the finished ones, but it runs once a day, removes at most 20, and each removal would freeze the agent's main server for about 3 seconds.

This change moves all of the cleanup's checking and removing into a separate background program, run every hour:
- a copy is first moved into a trash folder in one step, then deleted, so an interruption never leaves a half-removed copy;
- only one such program runs at a time;
- before each removal it checks everything again;
- real removal stays switched off until the Chief of Staff decides, with numbers.

## Original vs Converged

- **Evaluation moved too, not only removal.** The original moved only the removal. Review showed a live pass would still evaluate on the main thread, about 45 s per pass (`AgentWorktreeReaper.ts:346`). One child now does both.
- **Rename to trash, then delete.** The original removed in place with a kill deadline. A kill mid-`git worktree remove` leaves a half-deleted checkout that no later pass reclaims. The converged design renames the checkout into `.worktrees/.trash/`, runs `git -C <home> worktree prune`, then deletes. A kill leaves either the untouched checkout or only trash.
- **`git worktree prune`, not a hand-deleted admin entry.** One round deleted the worktree's `.git/worktrees/<id>` by hand. That was refused by the guard, and it trusted a writable `.git` pointer. Prune is git's own route, and the guard already allows it. It was verified on git 2.50.1 that a sibling caught mid-add is locked "initializing" and kept.
- **A guard that actually guards.** Review found the existing runtime-state rule allows any path containing `/.instar/`, which on agent homes is everything. That wider hole is filed as fb-abdf2088-f27. This change adds a narrow scope, checked first and deciding alone:
  - the rename source must be an evaluated direct child of `.worktrees`;
  - the destination and deletes must be inside the trash root;
  - its tests run from a home path that contains `/.instar/`.
- **Crash-safe records.**
  - Rows are fsynced: intent, attempt, renaming, renamed, and the outcome.
  - Recovery reconciles with the disk.
  - The lock is written fully before it appears, and is corroborated by run id.
  - Ownership is held by the process group until no member remains.
  - Trash deletes each run in a killable sub-process, under a 300 s budget, with retry counts that survive a restart.
- **Closed-unmerged PRs** count as finished only on an exact `headRefOid` match and a matching `git ls-remote refs/pull/<n>/head`.
- **Honest scope.** About 61 of the 74 copies made a day have a symlinked `node_modules` or none, and can be reclaimed hourly once clean and merged. About 13 a day hold a real npm install (about 0.7 GB), which the reaper keeps as work. That rule is the separate spec `reaper-node-modules-regenerable`. (An earlier draft said most copies clone `node_modules`; a re-count at 20:58 PT corrected it.)

## Iteration Summary

| Round | Standards-Conformance Gate | Material / design findings | Outcome |
|---|---|---|---|
| 1 | ran (2 flags: limits not derived, dev rung) | internal material; codex 3 design; cc 3 design | one child does eval + removal; own runner; O_EXCL lock; derived cap and deadline; outcome narrowed |
| 2 | ran (1 flag: limits, accepted) | internal material (old resume); codex 2; cc 3 | rename to trash replaces resume; cadence justified by backlog; fsynced rows |
| 3 | not run (no design change to limits) | internal material (guard, no rename primitive); codex 3; cc 3 | attempt rows; bounded trash; link lock; trash carve-out; walks skip trash; live report |
| 4 | ran after the server restart (same accepted flag) | internal material (admin delete refused); codex 2; cc 1 | back to `git worktree prune`; renaming row; config check before trash deletes |
| 5 | not run | internal none; codex 2; cc 2 | lock corroboration; prune pinned to the agent home; symlinks never followed |
| 6 (cap) | not run | codex 2 design; cc 1 design (guard hole) | guard scope checked first; killable trash deletes; group ownership. Internal confirmation found the sub-process delete needed a new guarded executor method (`safeRmTreeInSubprocess`) and a canonicalize helper refusing `.`/`..`; both added |

## Proportion

Tier 2: irreversible removal plus a guard change. All 6 of 6 rounds were used. Each round's findings got narrower, from architecture in round 1 to the guard order and sub-process ownership in round 6. Most of the cost came from crash-safety detail, which is the irreversible part.

## Left behind (accepted, with reason)

- **Fixed limits: hourly cadence, cap 20, 900 s deadline, 15 s start cutoff, 300 s trash budget, 3 trash retries.** Each is derived from a measurement, and each fails safe: hitting it postpones work to a later pass and never removes more. Re-tuned from run records at the maturation review.
- **A few milliseconds between the final re-check and the rename.** The same residual writer race PR 3480 accepts. An already-open file keeps writing into the trash copy.
- **Prune side effects.** A prune in the microseconds before git writes a new entry's lock makes that add fail loudly. Prune also drops entries for worktrees whose folder is missing elsewhere (re-linkable with `git worktree repair`; no commits lost).
- **The wider `/.instar/` guard hole** (fb-abdf2088-f27). It predates this change and needs its own spec. This change does not rely on it.
- **Worktrees with a real `node_modules` stay kept** (about 13 a day). Reclaiming them is the separate spec `reaper-node-modules-regenerable`.

## Full Findings Catalog

The round-by-round findings, with what each changed, are in the stewardship notes for 2026-11-18 (`.instar/stewardship/disk-leak-1118-evening.md`, "Spec reaper-removal-out-of-process" rounds 1-5, plus this report's table for round 6). The external reviewers' raw outputs are kept with the run.

## Convergence verdict

Converged at the round cap (6). Every design finding from rounds 1-6 changed the spec, and the round-6 fixes were confirmed against the code by the internal reviewer: the one gap it found, no guarded sub-process delete existed, is now a named executor method in the spec. The accepted items above are not safety, security or data-loss gaps. The spec is ready for the Chief of Staff's review and approval.

## Approval

Approved by the Chief of Staff, 2026-11-18 20:49 PT (msg 51cdd3bb), as a maintainer decision rather than a constitution change. Build it with real removal off, then bring the hourly dry-run counts plus PR 3480's numbers for the separate turn-on decision. Also approved: a separate spec making a `node_modules` clone whose files still match the source install count as regenerable.
