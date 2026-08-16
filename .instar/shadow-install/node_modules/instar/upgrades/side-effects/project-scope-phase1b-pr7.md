# Side-Effects Review — project-scope Phase 1b PR 7 (Autonomous run loop)

**Version / slug:** `project-scope-phase1b-pr7`
**Date:** `2026-05-11`
**Author:** `echo`
**Second-pass reviewer:** `required (new subprocess management + process-group signaling + filesystem allocation under target repo)`

## Summary of the change

Final PR of project-scope Phase 1b. Ships the autonomous run loop the
spec § Phase 1.5 names (steps 1-11), wired against the lock + preflight
+ runner primitives that landed in PRs 3-6:

- `ProjectRoundWorktrees` — lazy worktree allocator under
  `<targetRepoPath>/.worktrees/<projectId>/<roundIndex>/<itemId>`.
  Appends `.worktrees/` to `.git/info/exclude` on first call so the
  namespace doesn't pollute `git status`.
- `runRound(input, deps)` — the run loop. Acquires the lock, lazily
  allocates the first worktree, spawns the autonomous child in a
  detached process group, polls the project record every 60 seconds.
  On mid-round mutation to `round.itemIds`, SIGTERMs the child's
  process group (5s grace, then SIGKILL) and relaunches with the
  new stop condition. On the child's natural exit, verifies per-item
  artifacts via the caller-injected `verifyMergedItems` and sets
  `round.status` to `complete` | `partially-complete`. On
  `haltedAt` set mid-run, kills the child and returns `halted`.
  Three-attempt resume cap on transient non-zero exits before
  `failed`.

Spec source: `docs/specs/PROJECT-SCOPE-SPEC.md` § Phase 1.5.

New files:
- `src/core/ProjectRoundWorktrees.ts` (~140 lines) — pathFor,
  allocate, prune, remove, ensureExcludeEntry helpers. `SafeGitExecutor`
  for all git invocations.
- `src/core/ProjectRoundExecution.ts` (~340 lines) — the run loop
  itself, plus `verifyMergedItemsViaGit` helper for callers that want
  the real `git merge-base --is-ancestor` verifier instead of a stub.
- `tests/unit/ProjectRoundWorktrees.test.ts` (8 cases) —
  path-shape, allocate-creates, refuse-on-existing, idempotent
  exclude entry, prune-on-empty, remove-on-missing,
  remove-cleans-up, allocate-with-refuseExisting-false.
- `tests/unit/ProjectRoundExecution.test.ts` (8 cases) —
  lock-held-failure, first-pass-complete (no spawn), natural-exit
  full-verification, natural-exit subset → partially-complete,
  halt-mid-run, dynamic stop revalidation (itemIds mutation
  triggers relaunch), worktree allocated, exclude entry written.

## Decision-point inventory

- **Spawn in detached process group** (`spawnAutonomousChild`) —
  **add** — `detached: true` per Node `child_process.spawn`. The
  child gets its own process group; the runner is NOT a member.
  `process.kill(-pid, signal)` (negative PID = group target) reaps
  the child's entire process tree (compilers, test runners spawned
  by the autonomous skill) without reaping the runner. Spec § Phase
  1.5 step 5 calls this out explicitly.
- **Worktree allocation** — **add** — lazy on first use. Refuses
  by default if path exists (spec semantics); callers can pass
  `refuseExisting: false` to override (used on resume paths).
- **Per-step halt checkpoint** — **add** — before every iteration of
  the inner relaunch loop, re-reads `round.haltedAt` from the tracker.
  Set → SIGTERM the child, return `halted`.
- **Stop-condition verifier dependency injection** — **add** —
  `verifyMergedItems` is required input. Default (used when no
  override) is a no-op set (returns empty set), so production callers
  MUST pass a real verifier. Tests pass stubs. The real production
  verifier is `verifyMergedItemsViaGit`, exported alongside the run
  loop.
- **Resume cap** — **add** — 3 transient non-zero exits before
  `failed`. Spec § Phase 1.5 step 11.

## Over-block vs under-block analysis

### Process group signaling
Over-block: SIGTERM-grace-then-SIGKILL of the WHOLE process group
will reap any descendant process the autonomous skill spawned —
compilers, test runners, lockfile holders. This is intentional and
matches the spec.

Under-block: if the autonomous child somehow detaches FURTHER
(creates its own grandchild group), that group escapes. Acceptable
edge case — the autonomous skill is in-house and doesn't do that;
we'd notice in observability before it becomes a leak.

### Worktree allocation
Over-block: a stale worktree directory under `.worktrees/` from a
crashed previous run causes `allocate()` to throw. Callers (the
runner's first-item path) pass `refuseExisting: false` so the
allocator returns the existing path instead. Trade-off: a crashed
run's stale worktree is silently reused. Acceptable: `prune()` runs
on every successful round completion, and `git worktree add` would
itself complain if the worktree is corrupt.

Under-block: `prune()` runs `git worktree prune` against the whole
repo, not just our namespace. Worktrees registered by OTHER tools
(unrelated to project-scope) that have become stale will ALSO be
pruned. Acceptable: `git worktree prune` only removes administrative
entries pointing at missing paths — it does not delete live worktree
directories.

### Run loop
Over-block: a long-running autonomous child that takes 4 hours to
complete isn't capped here. Acceptable — the autonomous skill has
its own duration cap (stop hook); the run loop just watches for exit.

Under-block: a child that hangs without exiting AND without itemIds
changing AND without `haltedAt` being set sits forever. Acceptable
for this PR — the auto-advance poller's `LOCK_HELD` rejection will
eventually surface the stuck round in telemetry, and the user can
`POST /halt`.

## Signal vs authority audit

The run loop is **authority** for round-state transitions
(`complete` / `partially-complete` / `failed`). The decision is
deterministic: the caller-provided `verifyMergedItems` (a signal
source) returns a set; the run loop counts matched/unmatched and
sets `round.status` accordingly. The runner never sets a verdict
the verifier didn't support.

## Interactions with existing systems

- **`ProjectRoundLock`** — acquired at step 1, released at step 8 in
  the finally block (always releases even on throws).
- **`InitiativeTracker`** — single source of truth for `round.itemIds`,
  `round.haltedAt`, `round.status`. Polled every `pollIntervalMs`;
  mutated on outcome via `tracker.update(...)` with `ifMatch`. OCC
  races are silently ignored at outcome-recording time (next read
  will see the conflicting writer's state).
- **`SafeGitExecutor`** — every git invocation (worktree add / prune /
  remove, merge-base --is-ancestor) routes through the safe executor.
  No raw `execFileSync('git', ...)` anywhere.
- **`ProjectRoundRunner.preflight`** (PR 3) — the run loop assumes
  preflight has passed. It does NOT re-run preflight at step 1; the
  caller is expected to do it (auto-advance poller does; /project
  run-round skill does).
- **`ProjectAutoAdvancePoller`** (PR 4) — the poller calls
  `preflight` and then in PR 7+ can call `runRound` directly. PR 4
  bookkeeps unacked count + clears autoAdvanceAt; the run loop is
  the actual work-doer that follows.
- **`RoundCompleteDeliveryHelper`** (PR 6) — the run loop does NOT
  invoke the delivery helper. That's a caller concern (the poller
  or the skill consumes the run-loop result and constructs the
  message). Keeps the run loop's responsibilities tight.

## Rollback cost

Revert deletes `src/core/ProjectRoundWorktrees.ts`,
`src/core/ProjectRoundExecution.ts`, the two test files. Existing
worktree directories under `<targetRepoPath>/.worktrees/...` become
orphaned but harmless. `git worktree prune` from a subsequent
unrelated run cleans up the administrative entries. No schema
changes.

## What this PR explicitly defers

- **Wiring the poller / skill to call `runRound`.** PR 4's poller
  currently only bookkeeps; calling `runRound` is a small wiring
  task in a follow-up PR (the runner instance is already in the
  ctx; the poller just needs to invoke it).
- **`GET /projects/:id/next` real implementation.** Still 501.
- **Lazy merged-state reconciler on `GET /projects/:id`.** Spec
  Phase 1.5 — the read-may-mutate behavior with the ≤3-children-per-GET
  cap. Not implemented in PR 7; the
  `verifyMergedItemsViaGit` helper here is the building block the
  reconciler can call into in a follow-up.

## Verification

- `npm run lint` — passes (tsc + lint-no-direct-destructive).
- `npx vitest run tests/unit/ProjectRoundExecution.test.ts
  tests/unit/ProjectRoundWorktrees.test.ts` — 16/16 pass.
- Existing PR 1-6 invariants unaffected (the run loop is a new
  module; no shared-code mutations).
