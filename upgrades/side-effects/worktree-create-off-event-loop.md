# Side-Effects Review — topic workspace creation runs off the server's event loop

**Version / slug:** `worktree-create-off-event-loop`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, a narrow bug fix in `src/core/WorktreeManager.ts`. `createBinding()` (already `async`) ran `git worktree add` / `git clone` through `SafeGitExecutor.execSync` and the `node_modules` copy through `execFileSync`, holding the event loop for up to 30 s + 60 s (120 s + 600 s on the clone / plain-copy paths). On 2026-11-13 14:09Z that outlasted the supervisor's 60 s of failed health checks and the Studio server was restarted mid-run.

Now: the two `worktree add` sites and the clone run through a new private `gitWriteOffLoop()` (a promise around `SafeGitExecutor.spawn`), the three `cp` forms through the existing `execFileAsync`. Git is started as the leader of its own process group (`SafeGitOptions.detached`, new, honoured by `spawn` only); at the time limit the whole group is killed and the promise rejects at once. `worktree add` gets 120 s (`HEAVY_GIT_TIMEOUT_MS`), up from 30 s. `resolve()` keeps one in-flight creation per binding key (`creatingBindings`). What a failed or killed creation leaves on disk is not cleaned up by this change (section 2).

Files: `src/core/WorktreeManager.ts`, `src/core/SafeGitExecutor.ts` (the `detached` option: one field, one spread in `spawn`), the new test file.

Unchanged and still synchronous: the short ref checks and branch/checkout steps (3 to 5 s limits), `seedGitHooks`, and everything in `resolve()` after the binding exists.

## Decision-point inventory

- `WorktreeManager.resolve` — modify — joins an in-flight creation for the same key. The lock decision after it (LOCK_HELD or grant) is unchanged.
- `WorktreeManager.createBinding` / `addInstarSourceWorktree` / `fastCopyDeps` — modify — how three child processes are awaited. No decision logic.

---

## 1. Over-block

- A request that arrives while the same topic's workspace is being created now waits for that creation and then gets `LOCK_HELD` if the first session took the lock. Before the change the checkout itself could not be overlapped (the loop was blocked for its duration; the method did already yield later, at `await fsTypeProbe`), so the second request ran after it and got the same `LOCK_HELD`. Same answer, reached without a second git run.
- Nothing new is refused. `gitWriteOffLoop` refuses what `execSync` refused (read-only verbs, guard refusals): both go through `SafeGitExecutor`'s classification.

## 2. Under-block

- **Other synchronous work in this file is still on the loop**: the 3 s ref checks, `git branch` / `checkout` (5 s), `seedGitHooks` (3 s reads plus a small copy), `snapshotWorktree`. Each is bounded well under the supervisor's 60 s, but several in a row on a stalled disk add up. Not changed here: they are short, and making the whole method async-safe is a larger change than this repair.
- **Other synchronous git in the server** (for example `WorktreeReaper`'s `worktree add` at `src/monitoring/WorktreeReaper.ts:210`, `ProjectRoundWorktrees`) is not touched. <!-- tracked: CMT-1718 -->
- **The cap check straddles the awaits.** `MAX_ACTIVE_BINDINGS` is checked at the top of `createBinding`; with creations for different topics now able to overlap, two could both pass the check at 29 and end at 31. The cap is a soft housekeeping bound (30 records), and the eviction path runs on the next creation. It was already possible across the existing `await fsTypeProbe`.
- **The in-flight key is topic and mode, not path.** In `platform` mode the directory and branch come from the slug alone, so two different topic ids with one slug could still run two creations on one path. Narrow (sessions default to `dev` mode; only the HTTP route can set `platform`). The shared path predates this change, but one consequence is new: the second request can now arrive while the first checkout is still writing, pass the adopt check, take the lock and start a session in a half-written tree, where before it could only arrive after the checkout had finished. <!-- tracked: CMT-1718 -->
- **A killed creation leaves a partial workspace, and the next request adopts it. Not fixed here.** At the time limit git's process group is killed. For `worktree add` that leaves a partly checked-out directory and a git record locked as `initializing`; for a clone, a partial directory. The next resolve for that topic finds the directory and takes the "Adopt existing" branch, which checks only that `git rev-parse HEAD` succeeds there (true for any directory nested in the project) and skips the dependency copy and hook seeding. The old synchronous timeout (SIGTERM at 30 s) also left a partial directory that was adopted the same way, without the locked record. So this is the same failure as before, reached less often (120 s where it was 30 s), with one difference: the locked record stays until someone runs `git worktree unlock` and `prune`. A cleanup step (`worktree remove --force`, delete, `prune`) was written and then removed after independent review showed it made things worse: git refuses to remove a record locked as `initializing`, `prune` skips it, and every later `worktree add` for that path then fails, where adoption at least hands out a directory; the worktree-manager carve-out also refuses a forced remove on an instar checkout. A correct cleanup needs `worktree unlock` first and a stronger adopt check, and is its own change. <!-- tracked: CMT-1718 -->
- **The branch from `-b` survives a failed creation.** The retry then takes the existing-branch form of `worktree add`. Same as before.

---

## 3. Level-of-abstraction fit

The fault is in how three child processes are awaited inside one already-async method; the fix is there. A general `SafeGitExecutor.exec` (promise form) would be the better home for the helper, and other callers could use it; it is kept private here to keep this repair small, with the helper written on top of `SafeGitExecutor.spawn` so nothing bypasses the funnel.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No new block/allow surface. The lock authority (`LOCK_HELD`), fencing and signatures are unchanged. The in-flight map only prevents a duplicate side effect.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point added. The timeouts are transport limits.

## 4c. Self-action class (`unbounded-self-action`)

`defectClass: unbounded-self-action`, `closure: n/a` (negative declaration). The change adds a child-process spawn and a kill, which is what the convergence gate looks for, but neither is a self-triggered controller: one git child is started per workspace-creation request (a session spawn or the HTTP route, never a timer or a retry inside this code), it is killed at most once, at its own time limit, and nothing here retries, respawns or re-drives. Concurrent requests for one topic are joined into a single creation, so pressure on one topic produces one child, not many.

---

## 5. Interactions

- **SourceTreeGuard:** `SafeGitExecutor.spawn` runs the same `refuseUnrunnable` / `isSourceTreeCheckBypassed` path as `execSync`, so the `sourceTreeWorktreeManagerOk` carve-out for an instar source checkout applies identically (`tests/unit/WorktreeManager-instar-source-tree.test.ts`, 4 tests, pass).
- **What `spawn` does not do that `execSync` did:** it ignores `timeout`, `maxBuffer`, `encoding` and `input` (the helper's own timer is the only limit; stdout is discarded, stderr kept as its last 600 characters for the error).
- **Audit:** `spawn` writes its `allowed` audit line when the child starts, where `execSync` wrote it after success (and `denied` on a subprocess error). A failed background git therefore shows `allowed` in the git audit with the failure visible only as the thrown error. Noted, not changed.
- **In-flight sync-op marker / supervisor defer:** these steps were never wrapped in the marker; they no longer need to be.
- **Session spawn latency:** unchanged in the common case. A checkout that used to fail at 30 s is now given 120 s; at the limit git's process group is killed and the spawn fails then. The server stays responsive meanwhile.
- **Shutdown and server kill:** git now leads its own process group, so a kill of the server's process group no longer reaches it. A creation in flight when the server stops or is killed runs on to completion as an orphan (a finished checkout no session asked to keep; the next resolve adopts it as a complete worktree, though without the dependency copy and hook seeding that follow git in `createBinding`). Before, the synchronous git was a plain child in the server's group. The timer is `unref`'d so it does not hold the process open.
- **Windows:** a negative pid is not a process group there, so the group kill throws, is caught, and nothing is killed at the limit; the promise still rejects. The old path's timeout did kill git. Topic workspaces on Windows are not a supported path today.
- **`creatingBindings` cleanup:** removed in `finally`, so both success and failure clear it (test: "a failed creation is not remembered").

## 6. External surfaces

- Install base: every agent that uses topic workspaces runs this path. Behaviour visible to a user: none, apart from the server staying responsive.
- Persistent state: none added. Bindings file, locks, history: unchanged formats.
- Operator surface: none.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**: a workspace is a directory on the machine running the session; bindings and locks are already per-machine (lock records carry `machineId`). The in-flight map is in-memory, per process, and guards only a local side effect. No notices, no URLs.

## 8. Rollback cost

Pure code change: revert and release. No state or migration.

---

## Conclusion

Removes one measured cause of the server being restarted mid-work, with the duplicate-creation race that going async would otherwise open closed in the same change. Proven by a test that fails on the old code (0 timer ticks during a 700 ms git) and passes on the new, on both the clone path and the `worktree add` path.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude), given the code and not the author's conclusions; three reads
**Independent read of the artifact: concur (third read), with notes**

**First read: CONCERN, no blocker.** "The core fix is real: the three heavy steps no longer hold the event loop." Findings: (1) the time limit bounded nothing with real git, because killing git's parent left its checkout helper running and holding the pipe (measured: SIGKILL at 6.0 s, `close` at 83.6 s); (2) the leftover was then adopted without dependencies or hooks; (3) the timeout test was racy and had no helper process; (4) tests ran only the clone path; (5) the clone error text carried the destination path; (6) misstatements in this document.

**Second read, after a revision that added a process-group kill and a cleanup step: CONCERN, one blocker.** The group kill and settle-on-exit were found correct and safe by reading (Mac and Linux semantics) and by a run on Mac only. The blocker was the new cleanup: after a killed `worktree add`, git's record is locked as `initializing`; `worktree remove --force` refuses it, `prune` skips it, and every retry of `worktree add` then fails for that topic. Also: the forced remove is refused by the carve-out on an instar checkout; the cleanup could delete another key's workspace in the shared-slug case; `prune` is repository-wide; the timeout test could read a pid file that did not exist yet; and this document had the two guard claims the wrong way round.

**What was done:** the cleanup was removed entirely (code, tests, and the claims about it), leaving the off-loop steps, the group kill, settle on the timer or on `exit`, and the in-flight join. The timeout test now uses a 1.5 s limit and tolerates a helper that never started. Sections 2 and 5 above state what a killed creation leaves and that it is not fixed here.

**Third read, after the cleanup was removed: CONCUR, no blocker.** With the cleanup gone the change is no worse than the previous code on timeout, non-zero exit, server kill, and same-topic concurrent resolves. One narrow case is worse: two topics sharing a platform-mode slug can now have the second adopt the first's tree mid-checkout. Notes: the timeout test proves the group kill only when the fake git got far enough to start its helper; the reviewer did not verify that the timer test fails on the old code (the author did, by reverting the source), did not run real git under the group kill, and ran nothing on Linux.

---

## Evidence pointers

- `logs/server-freeze/freeze-20261113T140918Z.txt` (Studio): 4,067 of 4,067 main-thread samples in `node::SyncProcessRunner::Spawn` under an HTTP handler; child `git -C <agent home> worktree add -b topic/10000002656-…` aged 26 s; server at 0.0% CPU.
- `.instar/logs/lifeline-launchd.log` (Studio), same minute: `Server process alive but unresponsive for 6 checks (~60s) — restarting`.
