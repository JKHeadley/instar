---
title: "Topic worktrees: stop the stale locks, and measure what is safely reclaimable"
slug: "topic-worktree-reclaim"
author: "echo (echo-machine-stewardship)"
parent-principle: "Close the Loop"
eli16-overview: "docs/specs/topic-worktree-reclaim.eli16.md"
approved: true
approved-by: "echo-chief-of-staff (msg 5ecf7d6f, 2026-11-18, with 3 fold-ins)"
review-convergence: "2026-11-18T18:33:27.355Z"
review-iterations: 6
review-completed-at: "2026-11-18T18:33:27.355Z"
review-report: "docs/specs/reports/topic-worktree-reclaim-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Topic worktrees: stop the stale locks, and measure what is safely reclaimable

## Problem statement

Verified on main d61d6173b and on the Studio, 2026-11-18.

`.instar/worktrees` on the Studio holds about 70 GB in 161 entries. 101 of them are `topic-*`. Nothing ever removes a topic worktree, and the reasons go deeper than "no reaper runs":

1. **Locks are never released and never expire on disk.**
   - `SessionManager` calls `WorktreeManager.resolve()` at spawn (`SessionManager.ts:4675`), and that writes `.session.lock`. Only the HTTP routes call `release()` and `heartbeat()` (`worktreeRoutes.ts:133,140`).
   - With no heartbeat, every lock reads as not live to `resolve()` a minute after it is taken (`isLockLive`, `WorktreeManager.ts:1183`). The reaper's own in-use check, by contrast, keeps any checkout whose `.session.lock` file exists, live or not (`agentWorktreeGit.ts` `isInUse`). The lock's `bootId` is the OS boot (`detectBootId`, `:134`), so it does not change across server restarts.
   - The lock map is keyed by worktree path and loaded from disk at start (`:182`, `loadLocks` `:293`).
   - A killed session emits `sessionKilled`, not `sessionComplete` (`SessionManager.ts:6092,6106`).
2. **Nothing marks a binding finished,** and bindings are capped at 30. Most entries no longer have one.
3. **The reaper written for these worktrees is never constructed.** The reaper that runs (`AgentWorktreeReaper`, `server.ts:25891`) only looks under `<agent home>/.worktrees`.
4. **The existing clean check would keep almost every topic worktree anyway.** WorktreeManager leaves its own files in each tree:
   - `.instar/session-context.json` (untracked, never deleted, `:414-433`);
   - `.session.lock` (untracked);
   - the seeded `.husky/_/` (ignored);
   - for newer trees, a real-directory `node_modules` copied by `fastCopyDeps` (`:1030`).
   `classifyIgnoredEntry` counts all of these as work (`agentWorktreeGit.ts:127-135`). On the Studio, even with the lock, context file, `.husky/_` and gate records allowed, only about 18 of 101 read clean, before any merged check.
5. **The `topic-` name does not prove WorktreeManager made the entry.** 7 `topic-*` directories were made by hand (for example `topic-144007-diag`). 2 of the 101 are not registered linked worktrees: one full clone, and `topic-10000002573-pairing-link.patch`.
6. **Checkouts link into each other across folders.** 27 `node_modules` symlinks under `.worktrees/*` point into `.instar/worktrees/*`. The link index today walks only one folder per reaper instance (`agentWorktreeGit.ts:204-209`).
7. **The existing reaper does its git work on the server's main thread.** `evaluate()` is synchronous (`AgentWorktreeReaper.ts:235`; `SafeGitExecutor.readSync`, up to 30 s per call). Measured on the Studio in a separate read-only process, on 2026-11-18, without the GitHub check: a 40-checkout sample took 6.9 s of synchronous evaluation (mean 173 ms, p50 211 ms, max 419 ms). Projected over the 258 registered checkouts, that is **about 45 s of blocked event loop per pass**: a projection from the sample mean, not a measured full pass. The pass runs 15 minutes after every boot and then daily. Its route also re-evaluates synchronously, and on the live Studio it timed out at 30 s (fb-91e824f4-920). A removal failure would also throw: the catch emits Node's special `'error'` event with no listener (`AgentWorktreeReaper.ts:321`).

**Why this spec measures first.** Points 4 to 7 mean a removing reaper would need new residue rules, provenance, a shared link index, protection against creation races, binding deletion, and off-main-thread evaluation. Its yield is also unknown: perhaps 18 of 101 trees. This spec stops the lock files from accumulating, fixes the latent throw, marks future dependency copies, and measures off the main thread exactly what a removing reaper could safely reclaim. Removal is phase 2, built on these numbers. <!-- tracked: CMT-1958 -->

## Proposed design

### A. Locks stop accumulating

- **`WorktreeManager.releaseForSession(sessionId)`:**
  - deletes every lock entry whose `sessionId` matches, from the path-keyed map and from disk;
  - `SessionManager` calls it on both `sessionComplete` and `sessionKilled`;
  - it deletes the ending session's own lock, which may be under a minute old. That is correct: the session is over.
  - Only a deletion that succeeds, or finds the file already gone (`ENOENT`), counts as released. Any other unlink error keeps the lock in the map, is logged with its code, and is retried at the next start's orphan release.
- **At server start, release only orphaned locks.** The release runs synchronously, directly after `initialize()` and before `setWorktreeManager`, with no `await`. No `resolve()` can run before that point, so no lock this server writes can be caught mid-spawn. The lock map is also the authority for `signTrailer()` and `heartbeat()`. Both look a lock up by `sessionId` and fencing token without checking liveness (`WorktreeManager.ts:561`). A session that survives a server restart still signs through its loaded lock, so liveness cannot decide here.
  - Instead, a lock is released only when both of these hold:
    - its `sessionId` has no persisted session record with status `running` (`<stateDir>/state/sessions/<id>.json`);
    - no live tmux pane has its working directory inside the worktree. This is one `tmux list-panes -a -F '#{pane_current_path}'` read.
  - The record alone is never enough: a live pane in the tree keeps the lock. A tmux read that fails keeps every lock.
  - That covers sessions that ended while the server was down, which fire neither event.
  - An unreadable sessions directory releases nothing. A record file that exists but will not parse counts as running, so it keeps its lock. `starting` counts as running too.
  - **Known limits:**
    - Two server processes overlapping during a restart: the new one could release a lock the old one wrote just before recording its session. With the live-pane check, this needs the release to land in the moment between `resolve()` writing the lock and `tmux new-session` opening the pane in the tree, because the pane then keeps the lock.
    - A previous server that crashed between `new-session` and `saveSession` leaves a live session with no record. Its pane is in the tree, so the live-pane check keeps its lock.
    - Both are rare. The cost is that session's commit trailer failing to sign. Nothing is lost.
  - **On session end:** an end event is not proof the session stopped. `sessionComplete` also fires when `kill-session` failed and the pane is still alive (`SessionManager.ts:3876`). So the release also checks the session's tmux session (`isSessionAlive`), and keeps the lock while it is still there. The orphan release at the next start, or a later end event, picks it up.
- A lock from another machine is never touched.
- This part does not make the locks protective. Because nothing heartbeats, a second `resolve()` for the same topic can take over a live session's worktree once its lock is a minute old (`isLockLive`), against the "exclusive" promise in `WorktreeManager`'s header. A lease with a heartbeat is the standard fix. It is out of scope here and filed as its own bug. Nothing in B or D depends on it.

### B. One shared link root list; the reaper's latent throw fixed

- `buildInboundLinkIndex` walks one **root list**, shared by every reaper instance and by the measurement in D. It is a shared list, not a shared result: each process rebuilds the index per pass, so a fresh link is never missed through a cached index. The roots are:
  - `<agent home>/.worktrees`;
  - `<stateDir>/worktrees`, walked to depth 3 (the same as `.worktrees` today), pruning `node_modules`. Every cross-checkout link found on the Studio is a top-level `node_modules` (depth 2), which this covers. A link nested deeper inside a checkout's own files is not seen. That gap exists today for `.worktrees` too, and it is acceptable here because nothing in this spec removes on that basis. Phase 2 must close it before removal, for example by reading each candidate's own links rather than walking all roots. <!-- tracked: CMT-1958 --> A full-depth walk over 70 GB would hit the walk deadline, return null, and keep everything;
  - `<agent home>/.worktrees-deps`;
  - the agent home's top level (which covers `.instar/lanes`, already walked in full).

  `owner()`, which maps a link target back to its checkout, maps targets inside either worktree folder.
  A checkout that any of these links into counts as in use, whichever folder it sits in. Rebuilding per pass avoids a stale index between passes. A link created during a pass, after its folder was walked, can still be missed. That race is phase 2's to close before any removal. The running reaper therefore also stops being blind to links from `.instar/worktrees` into `.worktrees`.
- The reaper's removal catch emits `'reclaim-failed'` (a non-special event) instead of `'error'` (built on this branch). The breaker and the evidence row are unchanged. The two existing tests that listen for `'error'` (`tests/unit/agent-worktree-reaper.test.ts:949,970`) move to the new name.
- **The running reaper's index-lock check works for linked worktrees.** `isInUse` checks `<checkout>/.git/index.lock`. In a linked worktree `.git` is a file, so that path never exists. It now reads the lock from `git rev-parse --absolute-git-dir`, with a test.
- **The merged-PR lookup checks the destination branch** (built on this branch, with a test). The branch name comes from the resolved base ref (`main` from `origin/main` and the like), never a hard-coded `main`. `fetchMergedPrHeadOids` asks GitHub for `baseRefName` too, and keeps only PRs merged into the base branch. Today a PR merged into any other branch would count as merged into main, for the running reaper as well.

### E. (moved) The running reaper's main-thread block

Fixed separately, first, at the Chief of Staff's request (msg 0314fb4b): branch `echo/reaper-off-main-thread` runs the reaper's dry-run pass in a worker thread, and its route answers from the last pass. This spec builds on it. A live pass (`dryRun: false`) still evaluates in-process, and that limit belongs to phase 2. <!-- tracked: CMT-1958 -->

### C. Dependency copies are marked

`fastCopyDeps` writes `node_modules/.instar-deps-copy` after a successful copy, holding the source path and the time. Trees made before this change have no marker.

### D. Measure the topic scope off the main thread

The disk-steward child process already measures `.worktrees` with a read-only reaper (`measureWorktrees`, `diskStewardMain.ts:143`). It gains `measureTopicWorktrees` over `<stateDir>/worktrees`. Nothing in it can remove anything.

**Inputs.** D is given `agentHome`, `stateDir` and `projectDir` explicitly. None of them is derived from the worktrees folder: `path.dirname(<stateDir>/worktrees)` would be `.instar`, not the agent home. `git worktree list` runs against `projectDir`.

**Scope.** An entry is in scope only if all of these hold:
- it is a registered linked worktree (listed by `git worktree list`);
- WorktreeManager bound it: `<stateDir>/state/binding-history-log.jsonl` holds a `binding-created` event for this path, from this machine's `machineId`. Each line is a JSON object, a tab, then its HMAC; the parser reads up to the tab. Paths are compared after `realpath` on both sides.

`createBinding` also writes `binding-created` when it adopts an existing checkout, so this proves WorktreeManager bound the entry, not that it made it. For measuring that is acceptable. Phase 2 must add a creation-versus-adoption distinction before anything is removed on this basis.

On agents whose project lives outside `~/.instar`, topic worktrees are clones (`shouldCloneInsteadOfWorktree`). There, D reports nearly everything as `out-of-scope: clone`, so its numbers describe agents like the Studio's Echo, not the fleet.

Everything else is counted under `out-of-scope`, by reason: `hand-made`, `clone`, `no-provenance-record`, or `provenance-unreadable` (when the history cannot be read; that is not counted as in use, so a broken read is not mistaken for "everything is busy").

**In use.** D has its own in-use function. The existing `isInUse` returns true as soon as a `.session.lock` exists, which is the signal D drops. D does not use the lock-file signal: a `.session.lock` that exists says nothing about use, because old ones are never removed (A releases only those of ended or orphaned sessions). D keeps the git index-lock check, read at the worktree's own git directory. In a linked worktree `.git` is a file, so the directory comes from `git rev-parse --absolute-git-dir`. An entry is in use if any of these hold:
- a running session's persisted record (`<stateDir>/state/sessions/<id>.json`, with `status` and `cwd`) has a `cwd` equal to the entry or inside it. A record left `running` by a crash keeps entries in use, which undercounts but is safe. A running record with no `cwd` (interactive sessions, older records) is covered by the process cwd scan;
- the entry was bound but its first session never got its context file. `createBinding` writes the `binding-created` event only after `worktree add`, the dependency copy and the hook seeding finish, so a creation still in progress is not in scope at all (`no-provenance-record`). This rule covers the short gap between the binding and the context-file write, and a `resolve()` that threw afterwards: such an entry is kept as `creating`, with no time window.
- the existing cwd, link (via the shared index) or command-line signals apply (the regex is extended to `.instar/worktrees/<name>`).

An unreadable session directory, or any record that will not parse, counts every entry as in use.

**Residue.** This rule is classified as a decision point below. These files count as regenerable:
- `.session.lock`, and a leftover `.session.lock.tmp.<pid>` from `writeLockAtomic`;
- `.instar/session-context.json`;
- `.husky/_/`;
- gate records;
- a `node_modules` that is a symlink.

Anything else untracked or ignored is work, which keeps the entry. A real-directory `node_modules` is never treated as regenerable. Entries that hold one are counted in their own buckets, as estimates, not as a safety verdict:
- **`eligible`:** no real-directory `node_modules`, and everything else holds.
- **`eligibleIfMarkedDepsAccepted`:** the only extra is a `node_modules` carrying the marker from C, and `package-lock.json` matches the base ref as it stands at measurement time.
- **`eligibleIfUnmarkedDepsAccepted`:** the same, without the marker.

Phase 2 decides whether either estimate becomes removable. That will likely need a content manifest; timestamps cannot prove that nothing inside the copy changed.

**Merged.** The existing checks: patch-id, or the exact-OID merged PR.

**Audit.** Each entry in any eligible bucket is checked again. The outcome is total: every case lands in exactly one row.

| How the eligibility check found it merged | Audit check | agrees | disagrees | could not verify |
|---|---|---|---|---|
| HEAD is an ancestor of the base | `merge-base --is-ancestor`, plus a fresh status | both hold | fresh status shows work, or HEAD is not an ancestor | — |
| squash merge, through an exact-OID merged PR | patch-id of `git diff <merge-base> HEAD` against that of `git diff <mergeCommit>^ <mergeCommit>` (both lookups add `mergeCommit` to their `--json` fields), plus a fresh status | patches equal, status clean (**corroborated**: anchored on the same PR) | status shows work, or patches differ on paths main did not also change | patches differ only on paths main also changed, or the merge commit is not available locally |
| patch-equivalent by `git cherry` (rebased or cherry-picked), no PR | fresh status only: no check exists that is independent of `cherry` | — | fresh status shows work | always (`patch-equivalent, no independent check`) |

The patch is compared, not the tree, because a squash commit's tree also carries main's own changes to the same files.

Only `disagrees` counts against the check.

**Output.** `WorktreePlan` and `DiskStewardPoster` gain a `topicWorktrees` row:
- `eligible`, `eligibleIfMarkedDepsAccepted` and `eligibleIfUnmarkedDepsAccepted`: count and bytes for each;
- `audit`: agrees, disagrees and could-not-verify;
- `kept`: by reason (`in-use`, `creating`, `unmerged`, `work-files`, `unmarked-deps`);
- `outOfScope`: by reason;
- `falseEligibility`: count, plus up to 5 paths.

**Budget.** The child's run is killed at the server's 30-minute deadline, and it writes its result file once, at the end. Measured runs on the Studio already take 13 to 19 minutes before the whole-disk walk.
- D runs **after** the whole-disk walk, so the walk keeps exactly today's budget.
- D's deadline is `runDeadlineAt` minus a 60 s reserve. Reason: D's longest single bounded step is one 30 s `git` or `gh` call that may already be in flight at the deadline. Those 30 s timeouts are not new: they are the existing reaper's per-call defaults (`SafeGitExecutor.readSync`, `defaultRunGh`), and D reuses them unchanged. Adding the result write and process exit, under 30 s, gives 60 s. The reserve is fixed because it is derived from those step timeouts, not from the run budget. With no `runDeadlineAt`, the child's own exit timer is used instead.
- On a day with a long whole-disk walk, D gets little time and reports `partial`. Because D's rows persist per entry (below), a partial day still adds to the measured set.
- D's rows also go to their own file, `<stateDir>/local-state/topic-worktree-plan.json`, written as each entry finishes. A run killed later still leaves D's measured entries. When the child has no `runDeadlineAt`, the deadline comes from its own exit timer. That one deadline is passed to every step: the link index, each `git` and `gh` call, the audit, the targeted lookups and `sizeOf`. Each call's timeout is the smaller of its own default and the time left. Results are written as each entry finishes, so a step cut short by the deadline leaves the rows already measured and marks the row `partial`. Entries it does not reach are counted as `not-measured`, and the row says `partial`. 

Each pass writes its counts into the plan row. **False-eligibility cases** are also appended, one row each with their evidence, to `<stateDir>/local-state/topic-worktree-false-eligibility.jsonl`. These are rare, and phase 2 must see every one, so the file is never trimmed. Agreeing verdicts are not logged row by row: the per-pass counts are phase 2's evidence, along with a hand sample when phase 2 is specified.

## Decision points touched

| Decision point | Classification | Floor / justification |
|---|---|---|
| A: release a session's locks when it completes or is killed | invariant; basis: enumerable-domain; evidence: only entries whose `sessionId` equals the ended session's are removed | — |
| A: release an orphaned lock at start | invariant; basis: enumerable-domain; evidence: only a lock whose `sessionId` has no persisted `running` record AND whose worktree has no live tmux pane inside it; an unreadable sessions directory, malformed record or failed tmux read releases nothing | — |
| B: a merged PR counts only when merged into the base branch | invariant; basis: external-constraint; evidence: GitHub's `baseRefName` on the merged PR; a missing field keeps the entry, as unmerged | — |
| B: a checkout another checkout links into is in use | invariant; basis: enumerable-domain; evidence: one index over a fixed root list; a failed index scan keeps every checkout (existing behaviour) | — |
| D: which files count as residue | invariant; basis: enumerable-domain; evidence: a closed list of files WorktreeManager itself writes; anything not on it is work; a real-directory `node_modules` is never residue, only counted in separate estimate buckets | Measuring only: no removal acts on it in this spec |
| D: run the measurement at all | invariant; basis: external-constraint; evidence: `monitoring.diskSteward.topicWorktreeMeasure` through the dev-agent gate; dark on the fleet until graduated | — |
| D: in scope and in use | invariant; basis: enumerable-domain; evidence: provenance from the binding history, use from session records and the existing scans, and "creating" from the absence of the file `resolve()` writes on completion; unreadable sources read as in use | — |

## Frontloaded Decisions

- **Does anything get removed?** No. This spec removes no worktree. Phase 2 (live removal, with binding deletion, creation-race protection and removal off the main thread) is its own spec, built on the measured numbers and the audit file. <!-- tracked: CMT-1958 -->
- **Should dependency copies, marked or not, count as reclaimable?** That is decided in phase 2, with both estimates' byte counts in hand.
- **Rollout:**
  - A, B and C ship on. A changes the lock lifecycle: locks are released for ended and orphaned sessions. B tightens existing eligibility checks: more links seen, and only PRs merged into the base branch count. Neither adds a way to remove a worktree. C writes one small file.
  - D runs in the disk-steward child behind `monitoring.diskSteward.topicWorktreeMeasure`, resolved through the dev-agent gate (`resolveDevAgentGate`): live on development agents, dark on the fleet. The ladder entry graduates it on its own numbers (see Maturation plan). No `migrateConfig` write is needed, because an absent key means the gate's default.

## Maturation plan

- **test-agent-live:** two steps on a throwaway agent.
  - The fixtures below run on a throwaway repo and agent home.
  - D then runs live once on a throwaway agent (`~/.instar/test-deploys/`), with `monitoring.diskSteward.topicWorktreeMeasure` set on. That agent's own disk-steward child performs a manual run over fixture worktrees made through its own WorktreeManager. The `topicWorktrees` row in its disk report is compared with the expected buckets.
  - Only then does D go live on a development agent.
- **dev-agent-live:** live on Echo (Studio, Mini, M5) from the release that carries it. Over one week:
  - the `topicWorktrees` row in each disk report;
  - the number of `.session.lock` files in `.instar/worktrees` before and after (it must stop growing);
  - every `falseEligibility` case, read by hand.
- **fleet:** A, B and C ship ungated with the release: they change no removal decision. D is dark on the fleet behind `monitoring.diskSteward.topicWorktreeMeasure` (dev-agent gate) until it graduates.
- **graduation criterion:** over the dev-agent week:
  - the lock-file count stops rising;
  - at least two measuring runs produce a `topicWorktrees` row on the Studio;
  - every `falseEligibility` case is explained, or filed as a bug.
  A week without a measuring run is not a pass; the window extends.
- **dark-window:** none; live on release. If the criterion is not met within 14 days, the reason and a new date are recorded on CMT-1958.
- **ladder:** monitoring.diskSteward.topicWorktreeMeasure
- **ladder path:** dev-agent live, then fleet dark-to-on when the graduation criterion holds on the development agent. A, B and C have no flag; revert is their rollback.

## Maturation path

1. **Test agent:** unit and integration tests drive D against fixture worktrees in a throwaway repo and agent home.
   - Expected buckets:
     - (a) merged and clean with no real `node_modules`: `eligible`, audit agrees;
     - (a2) the same with a marked copy: `eligibleIfMarkedDepsAccepted`;
     - (b) merged with an unmarked copy: `eligibleIfUnmarkedDepsAccepted`;
     - (l) squash-merged with the merge commit present locally: audit agrees by content; and (l2) the same with the merge commit absent: audit could not verify;
     - (m) a PR merged into another branch: unmerged.
   - Expected kept or out of scope:
     - (c) dirty;
     - (d) unmerged;
     - (e) in use through a session record's cwd;
     - (f) a clone;
     - (g) a hand-made `topic-` entry with no history event;
     - (h) a creation in progress or never finished (no `session-context.json`);
     - (p) a linked worktree with an index lock in its git directory and no other in-use signal: in use;
     - (q) a whole-disk-walk day: D still completes within its slice;
     - (n) a binding event from another machine for the same path: out of scope;
     - (o) the measurement budget runs out: `partial`, with the rest counted as not measured;
     - (i) linked into from a `.worktrees` checkout;
     - (j) an unreadable sessions directory.
   - A injects a killed session, and its lock must go. A lock whose session has no running record is released at start, and one whose session is still running is kept. A session that survives a server restart can still sign a trailer. The reaper is given a failing removal, and the pass must survive.
2. **Development agent:** the disk report shows the `topicWorktrees` row on the Studio. Phase 2's spec cites it. Any `falseEligibility` is filed as a bug before phase 2 starts.
3. **Fleet:** A, B and C reach the fleet with the release. D rides the disk steward's existing fleet posture.

## Alternatives considered

- **A lease with a heartbeat instead of A.** A lease that expires, renewed on the session's own tick, would fix both the stale files and the broken "exclusive" promise, and would make the lock a valid in-use signal again. This phase does not take it, because it changes lock enforcement for every running session. That needs its own test of signing, takeover and restart (filed as fb-863304b6-8ae). A is a strict subset that only removes files that no longer serve a session.


- **Build removal now.** Rejected. The round-1 review found six independent ways removal could misjudge or race. Measuring first costs one release and shows whether the yield is worth that machinery.
- **Remove at `sessionComplete`.** It would miss branches that merge days later, which is the common case.
- **`git worktree lock`.** It needs the same release discipline as `.session.lock`, which A already supplies.

## Multi-machine posture

- **A, C:** machine-local. `machine-local-justification: hardware-bound-resource`. Locks, dependency copies and the worktrees live on one machine's disk.
- **B, D:** machine-local. `machine-local-justification: hardware-bound-resource`. Each machine indexes and measures its own disk.
- **The disk report row:** unified, through the existing `GET /disk-steward?scope=pool` merged read.
- **Provenance:** the binding history is append-only and never trimmed (`appendFileSync` only, `WorktreeManager.ts:668`). It may be git-synced (its file header says so), so D matches `machineId` as well as the path. The audit files live in the machine-local `local-state/` folder.

## Self-Heal Before Notify

Not applicable. No notice source is added.

## Verify the State, Not Its Symbol

- **A, on session end.** Symbol: the ended session's own end event. State claimed: that session no longer needs its lock. Corroboration: the lock's `sessionId` equals the ended session's (identity), and its tmux session is gone (termination).
- **A, at start.** Symbol: no persisted `running` record for the lock's session. State claimed: no running session will sign through this lock. Corroboration: the live state, meaning no tmux pane working inside the tree, read independently of the record. The persisted session status is the second signal, not an independent proof on its own: `signTrailer` checks only the lock and binding, and the crash and overlap windows named in A are known exceptions. Unmeasurable: an unreadable directory, or a record that will not parse, releases nothing.
- **D.** Symbol: "eligible". State claimed: by the checks D runs, nothing in the tree is unmerged work, and none of the use signals D reads (session records, process cwds, command lines, links to depth 3, the git index lock) shows it in use. It does not claim that no deeper link exists. This is a narrower claim than "removal is lossless": D does not see links nested deeper than the walk depth, and `could-not-verify` entries stay in their bucket, counted separately. Removal, which needs the stronger claim, is phase 2's to justify. Corroboration:
  - provenance from the binding history;
  - use from session records, the creation window, and the cwd, link and command-line scans;
  - the audit (ancestor check, or the corroborating patch comparison for a squash merge, plus a fresh status).
  Unmeasurable: any unreadable source makes the entry in use or out of scope, never eligible. The audit's disagreements are counted, never hidden.

## Open questions

*(none)*

## Carrier for phase 2

> **CMT-1958** — "Phase 1 (topic-worktree-reclaim spec) measures what is safely reclaimable and stops the lock leak. Phase 2: specify and build live removal on those numbers: creation-race protection, binding deletion, removal and its re-check off the main thread, a creation-vs-adoption provenance event, deeper link coverage, and a decision on dependency copies."

