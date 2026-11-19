---
title: "Worktree removal runs in its own process, on a cadence that keeps up with creation"
slug: "reaper-removal-out-of-process"
author: "echo (machine stewardship, topic 144503)"
tier: 2
parent-principle: "Capacity Safety — No Unbounded Self-Action (Bounded Blast Radius)"
parent-principle-fit: "The agent home gains about 74-86 worktrees a day on the Studio, nearly all from its own sessions. The reaper can reclaim at most 20 a day, and if it were live each removal would block the server's main thread for about 3 s. The agent's own disk use grows without a working bound."
eli16-overview: "docs/specs/reaper-removal-out-of-process.eli16.md"
review-convergence: "2026-11-19T04:47:32.935Z"
review-iterations: 6
review-completed-at: "2026-11-19T04:47:32.935Z"
review-report: "docs/specs/reports/reaper-removal-out-of-process-convergence.md"
cross-model-review: "ran"
approved: true
approved-by: "echo-chief-of-staff (msg 51cdd3bb, 2026-11-18 20:49 PT)"
---

# Worktree removal runs in its own process, on a cadence that keeps up with creation

## Problem statement

`AgentWorktreeReaper` (agent-home `.worktrees/`) evaluates off the main thread since PR 3449. Removal still runs on the main thread: `removeWorktree` throws in the evaluation worker by design (`agentWorktreeEvaluationJob.ts`, "Read-only: this path has no way to remove a worktree"). The reaper ships `dryRun: true`.

PR 3480 makes generated files archived residue. That raises the eligible count, at most about 123 of the 151 checkouts that are clean by git status. Before live removal can be turned on, the Chief of Staff set a precondition (msg 8a629537): the synchronous scans move off the main thread, or the cap drops.

Measured on the Studio, 2026-11-18 20:15 PT:
- `lsof -w -d cwd -Fn` takes 0.14-0.39 s, and `ps -axww -o command=` takes 0.04 s;
- `git worktree remove --force` of a 268 MB checkout with a symlinked `node_modules` takes 2.45 s;
- all of these are synchronous, so each live removal would block the event loop about 3 s, and a 20-removal pass about 60 s;
- the reaper runs every 24 h (`reapIntervalMs`) with `maxReapsPerPass` 20, so at most 20 reclaims a day.

Who creates worktrees, from the 74 created in the 24 h before 20:10 PT (classified by name and branch):
- 72 are made by agent sessions for their own work. Topic 144636's identity work alone made about 14.
- 2 are feedback-executor attempts; that pipeline already removes its own at the end of each attempt.
- By the branch's PR state at 20:10 PT: 11 merged, 8 closed, 38 open, 14 with no PR (rigs and scratch), 3 detached.

So about a quarter of each day's worktrees are finished within the day, and most of the rest finish later, when their PRs merge.

## What this change does and does not fix

It makes live removal safe to turn on and fast enough to keep up with eligible worktrees. It does not by itself stop the agent home from growing.

Session worktrees made by `InstarWorktreeManager` get an APFS copy-on-write clone of `node_modules` (`InstarWorktreeManager.ts:105-111`). That clone is a real folder, which the reaper rightly keeps as `work`. Its blocks are shared, so it costs little real disk. The real per-worktree cost is the checkout's own tracked files and build output, about 270 MB measured for a checkout with a symlinked `node_modules`.

Making those cloned-`node_modules` worktrees reclaimable is a separate decision, because it changes the long-standing rule that a real `node_modules` folder is kept. It is raised to the Chief of Staff with this spec's report, not decided here.

## Proposed design

### 1. One reclaim child does evaluation and removal

A reclaim run is one child process that both evaluates and removes. The main process only starts it, supervises it, and reads its result rows.

- **No live work on the main thread.** Today a live pass would evaluate in process: `evaluateAllOffThread` is gated on `!killsEnabled` (`AgentWorktreeReaper.ts:346`), which would mean about 45 s of main-thread work per pass. With this change, a live pass does no git, `lsof`, `ps` or file walk on the main thread. A dry-run pass keeps using the existing evaluation worker for the report.
- **The child is started from the agent home.** It runs `nice -n 10`, detached in its own process group, with `cwd` pinned to the agent home. The executors therefore write audit lines to the agent home's `.instar/audit`, never into a checkout (`SafeGitExecutor.ts:1021`).
- **Its own supervisor, built like the steward's.** The reaper gets its own runner with its own state directory and run record, following `diskSteward/pruneRunner.ts`. The process name it matches is a parameter, never `'diskStewardMain'`. Every supervision scan (`ps` for adoption and deadline handling) is asynchronous (`execFile`), never the synchronous one with a 10 s timeout.
- **One run at a time, enforced by the child.** The child takes an exclusive lock first: an `O_EXCL` lockfile holding its pid and run id, which a stale-lock check clears only when that pid is gone. It exits if the lock is held. The main process writes the run's intent durably before spawning, and does not start another run while a previous run's ownership is unresolved (process group still alive, or unknown).
- **Fresh evaluation per removal.** The child builds its own evaluation inputs: the inbound-link index (bounded at 300 s by `buildInboundLinkIndex`, `agentWorktreeGit.ts:306`) and one GitHub PR lookup. It re-evaluates each path immediately before acting, with PR 3480's archive and final re-check.

### 2. Rename to trash first, delete later

A checkout is never deleted in place. For each path, the child first writes a durable `attempt <attemptId> <path>` row, before any work that could block. Then, after the archive and the final re-check (PR 3480), it:
1. Asks git whether the worktree is locked (`git worktree list --porcelain`, the `locked` line for this path). A locked worktree is kept and reported.
2. Renames the checkout folder into `<worktreesDir>/.trash/<attemptId>` with a new guarded `SafeFsExecutor.safeRenameDirSync`. That call requires the target to be strictly inside the trash root and on the same volume (same `st_dev`), and refuses otherwise. `rename(2)` is atomic. Between the final re-check and the rename sit one `git worktree list --porcelain` read and one fsynced `renaming` row, a few milliseconds in all. That is the same kind of residual writer race PR 3480 already accepts for its re-check. After the rename, nothing new can open a file at the old path. A process that already had a file open inside the checkout keeps writing into the trash copy, which is then deleted. That is the same residual writer race PR 3480 accepts, and the in-use checks (`lsof` cwd, command lines) just before the rename narrow it to a writer that started in those milliseconds.
3. Runs `git -C <projectDir> worktree prune` through `SafeGitExecutor`, which already permits it (`SafeGitExecutor.ts:1931`). Prune drops only admin entries whose folder is missing and that are not locked. A sibling caught mid-`git worktree add` is safe: git locks a new entry with the reason "initializing" until its checkout exists. Prune never deletes a working folder, only git's bookkeeping for a missing one. The child never deletes anything under `.git` by hand, and never trusts the checkout's `.git` file to name a path.
4. Deletes the trash folder.

Between steps 2 and 3, `git worktree add` at the old path would fail with "missing but already registered". The window is one prune call, and it is noted, not guarded against.

Two benign side effects of prune, accepted:
- **A gap at the start of an add.** Git creates a new admin folder microseconds before it writes its `locked` file. A prune in that gap drops the new entry, and that add then fails loudly instead of silently. (Verified on git 2.50.1: mid-add, the entry reads `locked initializing` and prune keeps it.)
- **Other missing worktrees.** Prune is repo-wide, so it also drops entries for worktrees whose folder is gone elsewhere, such as under a reboot-cleared `/tmp` or on an unmounted disk. No commits are lost, and `git worktree repair` re-links an entry whose folder comes back.

**Only agent-home checkouts.** The child acts only on a checkout whose `git rev-parse --git-common-dir` resolves to `<projectDir>/.git`, the agent home's own repository. Any checkout under `.worktrees/` that belongs to another repository is kept and reported as `other-repo`. So a single prune against the agent home is enough.

**Guard carve-out.** Today's guard does not protect these paths. `isUnderAgentRuntimeState` (`SafeFsExecutor.ts:97-103`) allows any path that contains `/.instar/` anywhere. Agent homes live at `~/.instar/agents/<name>/`, so every path in the agent home passes that carve-out before the source-tree check runs. That wider hole is filed separately as feedback; it predates this change and is fixed through its own spec. This change does not rely on that carve-out:
- a new `worktreeTrashScope: { worktreesDir, trashRoot }` option, checked **first** in `guard()`, ahead of the runtime-state carve-out. When the option is given, the call is decided by it alone: allowed if the path qualifies, refused otherwise, never falling through to a broader rule;
- a rename **source** qualifies only if it is a direct child of the realpath of `worktreesDir`, is not `.trash`, and is in the child's list of paths that passed this run's evaluation;
- a rename **destination** or a **delete** qualifies only if it is strictly inside the realpath of `trashRoot`, and the trash root is not itself a symlink;
- a target that does not exist yet (the rename destination) is canonicalized by a new helper: the realpath of its parent folder plus the last name. A last name of `.` or `..` is refused. A symlinked component in the parent's path then resolves rather than refusing.

The guard tests run from a home path that itself contains `/.instar/`, as the real one does, so a broad carve-out cannot make them pass by accident.

**Walks skip the trash.** `buildInboundLinkIndex` (walks `worktreesDir` to depth 3, `agentWorktreeGit.ts:312`), `listWorktrees`, and any `.worktrees/*` listing skip `.trash`.

A kill at any point leaves one of two states, and neither is a half-deleted live checkout:
- the checkout untouched at its path, if the kill came before the rename; the next pass evaluates it fresh;
- a folder in `.trash/` only, if the kill came after the rename; its admin entry may still exist, and the next run's `git worktree prune` drops it.

**Leftover trash cleanup is bounded.** Each run first deletes leftover trash, one folder at a time. Each folder's delete runs in its own sub-process through a new executor method, `SafeFsExecutor.safeRmTreeInSubprocess`. It calls `guard()` with `worktreeTrashScope`, writes the audit row, then runs `rm -rf -- <canonical path>` with no shell. BSD `rm -r` removes a symlink as a link and never follows it, and `-f` keeps an unwritable file from stopping it at a prompt. The method records `allowed` or `denied` when the process exits, and it is killed at whatever remains of the 300 s cleanup budget. A bare `rm` that skips the guard is never used. A hanging delete therefore stops at the budget, and the run moves on to candidates. Each delete writes a `trash-start <folder>` row and then `trash-done` or `trash-error`. A delete that fails, or that was cut off by a kill or the deadline (a `trash-start` with no outcome), counts toward that folder's own retry limit. Retries back off on later runs, and after 3 failures the folder is skipped. A partly deleted trash folder is simply deleted further next time, since nothing in it is live. A stuck trash folder therefore cannot use up the runs meant for healthy candidates.

A skipped trash folder stays in the report as `trash-stuck`, with its size and last error. That is a disk-steward finding for the machine stewardship owner. It blocks graduation (see the Maturation plan) until it is deleted or explained. Retry counts are kept in a small file next to the run records, so a restart does not reset them. Deleting the folder resets its count.

**Why not `git worktree move`, then `remove`.** `git worktree move` would update git's record as it renames. But finishing with `git worktree remove --force` is refused by the source-tree guard (`SafeGitExecutor.ts:1929-1938`), and removing a moved checkout without `--force` fails on its untracked residue. Rename-then-prune uses only calls the guard already allows, plus the one narrow trash carve-out.

Nothing in `.trash/` is a live worktree, and nothing there needs evaluation. Its contents are already archived (residue) or proven in git (registry copy), or the checkout was clean and merged.

**Switching back to dry-run mid-run.** Before each removal and before each trash-folder delete, the child re-reads `monitoring.agentWorktreeReaper` from the agent's config file on disk. It stops if `dryRun` is now true or the reaper is disabled. A switch back to dry-run therefore stops the run at the next step, not after 20.

**No overlap with the disk steward.** The steward's live deletions are limited to its caches: the npm cache, Xcode DerivedData and the context archive. Its worktree measuring is read-only. Neither touches `<worktreesDir>`, so the two children cannot delete the same files.

**The trash delete goes through the guarded executor.** The rename and the delete run through `SafeFsExecutor`, with the audit trail. Both the rename source and its destination are authorized: the source must be a reap-eligible checkout directly under `<worktreesDir>` that passed this run's evaluation, and the destination must be inside the trash root. The new `worktreeTrashOk` carve-out is the only allowance used. If the build cannot make it pass its tests, removal stays off; there is no fallback to a wider rule.

**Symlinks are never followed.** Every eligible checkout's `node_modules` is a symlink to the shared, live install. The trash delete removes a symlink as a link and never descends through it. Node's `fs.rm` with `recursive` already does this, and `SafeFsExecutor`'s recursive delete is pinned to that behaviour by a test that puts a symlink to a live folder inside the trash and checks that the folder survives.

**Two writers on the audit trail.** The child and the main process can both append to `.instar/audit/destructive-ops.jsonl`. Rotation already handles concurrent writers (`SafeGitExecutor.ts:1039`): a narrow re-stat-then-rename guard, accepted as is.

**Durable rows.** The result file is append-only, and each row is written and then `fsync`ed:
- `intent <runId>`, written by the main process before spawn; if that write fails, the run is not started;
- `attempt <attemptId> <path>`, before any work on that path;
- `archived <attemptId> <manifest-sha256>`;
- `renaming <attemptId> <trash>`, written before the rename, and `renamed <attemptId>` after it;
- the terminal row: `removed <attemptId>`, or `kept <attemptId> <reason>`, or `error <attemptId> <reason>`.

The breaker reads each attempt at most once, deduplicated by attempt id across restarts:
- recovery reconciles each open attempt with the disk, not only with its rows. If its trash path exists, it is leftover trash: it is not a failure, and cleanup takes it. If its original path still exists and its trash path does not, the attempt died before the rename and counts as one failure for its path;
- trash cleanup lists the `.trash/` folder itself, so a folder there is cleaned whether or not its rows survived. A trash folder with no attempt row is reported, then cleaned the same way, since only the child renames into `.trash/`.

A torn last line is ignored.

**The lock file always has its contents.** The child writes `{pid, runId, startedAt}` to a temp file, `fsync`s it, then `link(2)`s it to the lock path. `link` fails if the lock already exists, so a lock can never exist empty. The lock is stale, and may be cleared, when its pid is gone or that pid's command line does not contain the lock's run id (a reboot can reuse the pid), the same corroboration `pruneRunner.ts` uses for its run record. Ownership is held by the run's process group, not only its leader. The main process records the group id at spawn. It treats a run as finished only when no process in that group remains, checked with an asynchronous `ps -g`. So a child that died while its `git` or `rm` sub-process kept running still holds the lock. Past the deadline, a surviving group that still corroborates (a member's command line contains the run id) is killed with escalation, the same as `pruneRunner.ts`. A group that no longer corroborates after a reboot (pids reused) is treated as gone. Exclusion is released only once the group is confirmed gone, so a reboot cannot jam the reaper. A lock that cannot be read is treated as stale only once it is older than the run deadline.

### 3. The breaker sees the child's results

The child's rows feed the existing `recordReclaimFailure` in the main process (`AgentWorktreeReaper.ts:251, 549`). A path whose run was killed mid-removal counts as a failure. Paths with an open breaker are left out of the list the child may act on, so one stuck path cannot starve the ones after it.

### 4. Cadence keeps up with creation

The pass interval becomes 1 h. When live, each pass starts at most one reclaim run, which stops at the cap or the deadline. Both are derived:
- **Cap:** stays the existing `maxReapsPerPass` (20). Its justification is draining the backlog: at most about 123 eligible worktrees today (PR 3480). New eligible ones are only merged or closed worktrees whose `node_modules` is a symlink, and that rate is small while cloned-`node_modules` worktrees stay `work`. With 20 per hourly run, the backlog drains in about 6 hours instead of about 6 days with one run a day, and a worktree that becomes eligible is reclaimed within about an hour.
- **Deadline:** the sum of three bounded parts. That is up to 300 s for trash cleanup, plus the 300 s link-index bound, plus the cap times the measured per-removal time times 5 (20 × 3 s × 5 = 300 s). In all 900 s, so 15 minutes. Because of the rename-first order, a run killed at the deadline leaves only trash, so the deadline is a plain backstop.
- **Time-left rule:** the child starts a new removal only while at least five times the measured per-removal time, 15 s, remains before the deadline.

**The report in live mode.** The child writes its full evaluation (every worktree's verdict and reason, plus the PR 3480 projections and counts) to the same report file the route serves. So once removal is live, the report shows the complete picture, the kept worktrees as well as the removed ones. A dry-run pass keeps using the worker.

That allows up to 480 reclaims a day. The hourly dry-run pass costs about 45 s of worker CPU and one `gh` call (60 s cache, `agentWorktreeGit.ts:890`) per hour. That is off the event loop and far below GitHub's rate limit.

### 5. Closed-unmerged PRs

A branch whose PR is closed without merge counts as merged only when both of these hold:
- a new closed-PR lookup (`gh pr list --state closed`, with `number`, `headRefOid` and `mergedAt`) shows the PR closed and unmerged, with `headRefOid` exactly equal to the worktree's `headSha`;
- `git ls-remote origin refs/pull/<n>/head` returns that same SHA.

The commits then survive on GitHub's PR ref. The race guard (`agentWorktreeGit.ts:528`) and the final re-check apply the same rule. A branch with no PR stays unmerged and is kept. That covers the 14 rig and scratch worktrees from a day's sample, which this spec does not reclaim.

### 6. Live removal stays a decision

This change ships with removal still `dryRun: true`. With `dryRun: true`, the hourly pass evaluates in the worker and reports, and the child is never started.

Turning removal live on the Studio is the Chief of Staff's decision, made with PR 3480's dry-run numbers. The settings are `monitoring.agentWorktreeReaper.dryRun: false` and the existing ladder `monitoring.agentWorktreeReaper`. This spec satisfies the recorded precondition: no live removal work on the main thread.

## Decision points touched

- **Whether a reap-eligible worktree is removed in a run.** — invariant. basis: irreversible-consequence; evidence: the child repeats the full fail-closed evaluation (in use, clean or archived residue, merged) immediately before acting, then PR 3480's archive and final re-check, so a removal happens only when every safety gate clears at the moment of removal; anything else keeps the checkout.
- **Whether a closed-unmerged PR's branch counts as merged.** — invariant. basis: irreversible-consequence; evidence: only when the closed PR's `headRefOid` exactly equals the worktree's head and `git ls-remote origin refs/pull/<n>/head` returns that SHA, so the commits survive on GitHub; otherwise it is unmerged and kept.
- **Run cap and deadline (20 removals, 900 s backstop).** — judgment-candidate. The values are derived: the cap drains the measured backlog (about 123) within about 6 hourly runs, and the deadline is the trash-cleanup bound plus the link-index bound plus the cap times the measured per-removal time times 5. Floor: no removal starts without five times its measured time left; removal is attempt row, archive, re-check, rename-to-trash, `git worktree prune`, then trash delete, so a killed run leaves the checkout intact or only trash; leftover trash cleanup is bounded to 300 s with backoff; the deadline is a backstop. Arbiter: the reaper's existing `maxReapsPerPass` and breaker. Re-tuned from the run records.

## Frontloaded Decisions

- **Removal stays off.** This change only makes removal safe to turn on. The Chief of Staff decides when (msg 8a629537).
- **Closed-unmerged branches are reclaimable only when their head is on the remote PR ref.** Decided here, because 8 of 74 were closed in a day.
- **Rig and scratch worktrees with no PR stay kept.** Reclaiming them needs an owner signal that does not exist yet. They are counted in the report so their share stays visible.

## Accepted conformance flags

- **Judgment Within Floors: the cadence, cap, deadline, time-left cutoff, trash budget, trash retry count and graduation window.** Accepted. Each value is derived above from a measurement (the creation rate, per-removal time, and the link-index bound), and every one fails safe. Hitting a limit only postpones a removal or a trash delete to a later pass; it never removes more, and never removes without the full evaluation. A trash folder skipped after 3 tries stays visible as `trash-stuck` and blocks graduation, so that limit cannot hide anything. The values are re-tuned from the run records at the maturation review. The 14-day window is the observation span for the graduation floors, not a gate on any single removal.

## Multi-machine posture

`machine-local-justification: hardware-bound-resource`. Each machine reclaims its own checkouts on its own disk, in its own child process.

## Testing

- **Main process:**
  - with `dryRun: true`, no child is started and the report comes from the worker;
  - with `dryRun: false`, no synchronous git, `lsof` or `ps` runs on the main thread during a pass;
  - one child per pass;
  - a failed `intent` write starts no run, and no new run starts while ownership is unresolved;
  - async supervision scans; adoption after a simulated restart; the deadline backstop;
  - in live mode, the route serves the child's full evaluation.
- **Child:**
  - lock: the temp-plus-`link` lock is never empty; a second child is refused; a lock whose pid is gone, or now belongs to a process without the run id, is cleared;
  - a checkout of another repository is kept as `other-repo`; prune runs with `-C <projectDir>`;
  - a symlink to a live folder inside the trash is removed as a link and the live folder survives;
  - a trash delete cut off by a kill counts toward its own retry limit; several hanging trash folders stop at the 300 s budget and healthy candidates still run; retry counts survive a restart;
  - a leader death with a surviving sub-process keeps exclusion until the group is gone;
  - guard: `worktreeTrashScope` decides alone when given, ahead of the runtime-state carve-out; tests run from a home path containing `/.instar/`;
  - re-evaluation keeps a path that became dirty, in use or unmerged;
  - the time-left rule stops before the cap;
  - order: `attempt` row, then archive and re-check, then the rename into `.trash/` through `safeRenameDirSync` (target inside the trash root, same volume), then `git worktree prune` (a sibling locked as "initializing" keeps its entry), then the trash delete;
  - a locked worktree is kept;
  - a kill before the rename leaves the checkout intact; a kill after it leaves trash that the next run clears within its 300 s trash budget;
  - a failing trash delete backs off and is skipped after 3 tries;
  - rows are fsynced; the breaker counts an attempt once across restarts; a torn last line is ignored;
  - `cwd` is the agent home;
  - the child re-reads the on-disk config before each removal and each trash delete, and stops when `dryRun` turns true;
  - a kill between the `renaming` row and the rename, or between the rename and the `renamed` row, is reconciled from the disk;
  - a trash folder with no rows is cleaned and reported.
- **Guard:** `worktreeTrashOk` allows only paths strictly inside the trash root's realpath, refuses a symlinked trash root, and every other path is still refused. `.trash` is skipped by `buildInboundLinkIndex` and by `listWorktrees`.
- **Breaker:** the child's failure rows trip it; a tripped path is left out of the list sent to the child.
- **Closed-unmerged PRs:** `headRefOid` match plus `ls-remote` match means merged; a head mismatch, a missing ref, or no PR means unmerged.
- **Integration:** a real throwaway agent home with real worktrees, live removal on the throwaway only. It checks the full order, a dirty worktree kept, a sibling worktree's registration intact, a run killed after a rename whose trash is cleared next run, and no event-loop block above 1 s during the run.

## Maturation plan

- **test-agent-live:** the integration case above on a throwaway agent home, plus one run killed at its deadline and adopted after a restart.
- **dev-agent-live:** on Echo with removal live (`dryRun: false`) once the Chief of Staff says yes. Until then the hourly dry-run pass and report run.
- **fleet:** removal stays `dryRun: true` on every agent until the ladder review. The hourly dry-run pass ships, since its evaluation is already off-thread.
- **graduation criterion:** over 14 days of live dev-agent runs, every machine-checkable floor must hold:
  - zero removals of a checkout that the child's own re-evaluation did not class eligible;
  - zero archive verify failures that still removed;
  - no event-loop block above 1 s attributed to a reclaim run (block-watch against run-record times);
  - within 48 h of going live, the eligible-but-not-reclaimed count reported by the dry-run report is at most 20, one run's worth;
  - no `.trash/` folder older than 2 h, and no `trash-stuck` entry left unresolved.

  Above those floors, a maturation-board judgment weighs the run records (removed, kept, errors) before fleet.
- **dark-window:** if live removal is not decided by 2026-12-09, the board entry records why and a new date.
- **ladder:** monitoring.agentWorktreeReaper

## Rollout

Ship with `dryRun: true`. After install, report the hourly pass's eligible counts to the Chief of Staff, alongside PR 3480's projections, for the live-removal decision.
