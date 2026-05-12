# Side-Effects Review — project-scope Phase 1b PR 3 (Round runner + halt/advance/ack endpoints)

**Version / slug:** `project-scope-phase1b-pr3`
**Date:** `2026-05-11`
**Author:** `echo`
**Second-pass reviewer:** `required (new HTTP mutating surface + lock primitive + cross-record mutation orchestration)`

## Summary of the change

Third PR of project-scope Phase 1b. Ships the **single-chokepoint runner**
that the spec names in § Phase 1.5, plus the four mutating HTTP endpoints
that route through it (`/advance`, `/halt`, `/ack`, `/accept-partial`).
The actual autonomous-delegating run loop and dynamic stop-condition
revalidation are intentionally deferred to a follow-up PR — this PR
ships the **preflight gate** + **lock primitive** + **state-management
verbs** without the orchestration loop, so the routes can be exercised
end-to-end with real validators today.

Spec source: `docs/specs/PROJECT-SCOPE-SPEC.md` § Phase 1.5 (preflight,
lock, halt switch, runner authority model), § Phase 1.3 (HTTP endpoints).

New files:
- `src/core/ProjectRoundLock.ts` (~150 lines) — machine-local lock
  primitive at `.instar/local/round-runner.lock`. Acquire encodes
  `{pid, projectId, roundIndex, acquiredAt}` as JSON, atomic via
  `O_CREAT|O_EXCL` write + rename. Stale-PID sweep on every acquire
  uses `process.kill(pid, 0)`. Release / read / isAlive helpers.
- `src/core/ProjectRoundRunner.ts` (~470 lines) — the single
  chokepoint. `preflight(projectId, roundIndex)` runs the 9 deterministic
  checks from § Phase 1.5 (drift check, step 10, deferred to a follow-up
  PR alongside the cache+ledger HTTP wiring). `halt`, `recordAck`, and
  `acceptPartial` are idempotent state-management verbs that mutate
  through `InitiativeTracker.update()` with OCC. Static
  `validateChildFrontmatter` exported for future `run()` and dashboard
  consumers — verifies `review-convergence: true` AND `approved: true`.
- `tests/unit/ProjectRoundLock.test.ts` (9 cases) — acquire on free,
  reject on held + alive PID, stale-PID sweep, release returns true /
  false correctly, malformed-file tolerance, `isAlive` edges.
- `tests/unit/ProjectRoundRunner.test.ts` (27 cases) — all preflight
  reject codes (`PROJECT_NOT_FOUND`, `PROJECT_NOT_PROJECT_KIND`,
  `PROJECT_INACTIVE`, `ROUND_INDEX_OUT_OF_RANGE`, `PROJECT_HALTED`,
  `FIRST_LAUNCH_ACK_REQUIRED`, `UNACKED_ADVANCES_OVER_CAP`,
  `ROUND_ACK_GAP_TOO_LARGE`, `NOT_OWNER_MACHINE`,
  `TARGET_REPO_PATH_INVALID`, `LOCK_HELD`, `ITEMS_NOT_ALL_APPROVED`) +
  happy path, halt idempotent + lock-release behavior, recordAck
  semantics (populate + reset + never-regress + idempotent on index),
  acceptPartial (skip + complete-with-skips + ack-advance),
  `validateChildFrontmatter` happy + reject cases.

Modified files:
- `src/server/routes.ts` (+~190 lines) — adds `projectRoundRunner`
  field to `RouteContext`. Adds four mutating routes:
  - `POST /projects/:id/advance` — single-item stage transition through
    `StageTransitionValidator`. Requires `If-Match` (OCC). Body:
    `{itemId, targetStage, artifact: {...}, fromStage?}`. Returns
    409 on validator reject (with code + reason), 409 on version
    mismatch, 404 on unknown child / non-project record, 428 on
    missing `If-Match`. Bumps project version on success so concurrent
    /advance calls don't operate on a stale view.
  - `POST /projects/:id/halt` — calls `ProjectRoundRunner.halt`. Body:
    `{reason}`. Idempotent.
  - `POST /projects/:id/ack` — calls `ProjectRoundRunner.recordAck`.
    Body: `{forRoundIndex}` (or `{roundIndex}` for symmetry).
  - `POST /projects/:id/accept-partial` — calls
    `ProjectRoundRunner.acceptPartial`. Body:
    `{roundIndex, reason, skippedBy}`. Both `reason` and `skippedBy`
    required (downstream StageTransitionValidator demands them on
    every `* → skipped` transition).
- `src/server/AgentServer.ts` (+5 lines) — `projectRoundRunner`
  field added to `AgentServerOptions` + passed through to the
  `RouteContext`.
- `src/commands/server.ts` (+10 lines) — instantiates
  `ProjectRoundRunner` at startup, passes it into `new AgentServer({})`.
  `machineId` falls back to `os.hostname()` when the multi-machine
  coordinator isn't configured, matching the existing fallback in
  `src/commands/server.ts:5428`.
- `tests/integration/projects-api.test.ts` (+~150 lines) — 11 new
  integration cases covering the four new routes. `targetRepo` is
  now `git init`-ialized in `beforeAll` so preflight step 8 passes;
  the `ProjectRoundRunner` is instantiated and passed into
  `AgentServer`.

## Decision-point inventory

- **Preflight gate** (`ProjectRoundRunner.preflight`) — **add** — the
  single chokepoint for round-start authority. Routes don't re-implement
  these checks; the runner is authoritative. Drift check (step 10) is
  intentionally deferred until the drift-check HTTP endpoint and its
  cache+ledger wiring are in place.
- **Lock acquisition** (`ProjectRoundLock.acquire`) — **add** —
  `O_CREAT|O_EXCL` + rename. Stale-PID sweep ensures a dead runner
  doesn't permanently block subsequent acquires. The lock file is
  MACHINE-LOCAL (under `.instar/local/`, not git-synced), matching the
  spec's separation between machine-level mutual exclusion and
  cross-machine ownership via `ownerMachineId`.
- **Stage transition rejection** (`/advance` calling
  `validateStageTransition`) — **reuse** — the validator from PR 2 is
  the authority for artifact-bound transitions. Routes return its
  rejection code verbatim.
- **OCC enforcement on every mutating route** — **add** — `If-Match`
  required on `/advance` (428 if missing, 409 if stale). Halt, ack,
  accept-partial use the tracker's own `If-Match`-aware `update()`,
  re-asserting the spec's OCC contract across the new routes.
- **Halt as idempotent kill switch** (`ProjectRoundRunner.halt`) —
  **add** — finds the active round (preference: in-progress → pending /
  ready → already-halted) and writes `haltedAt` + `haltReason` if not
  already set. Releases the lock if the calling machine holds it. The
  SIGTERM-of-autonomous-child path lands when `run()` ships in a
  follow-up.

## Over-block vs under-block analysis

### Preflight
Over-block: every reject code corresponds to a documented spec invariant
(see § Phase 1.5 steps 1–9). Returning a structured `code` (rather than
just `reason`) lets the dashboard render targeted UI hints later. The
default-undefined round status is treated as `'pending'`, so freshly-
parsed plan-doc rounds don't false-negative on a status check.

Under-block: step 10 (drift check) is missing here. The follow-up PR
that wires the drift-check HTTP endpoint will add it to preflight in
the same commit. Until then, callers SHOULD treat preflight as
"deterministic gate passed; drift signal still pending."

### `/advance` route
Over-block: rejects with 409 on every validator failure (file missing,
slug regex fail, frontmatter mismatch, mergeCommit not on origin/main,
etc.). The 409 body carries `{error, code, reason}` so callers can
distinguish failure modes. **Refuses to advance without
`If-Match`** even though the canonical project record may not have
changed — protects against TOCTOU when two clients race
on the same record.

Under-block: `/advance` operates on child records, not on rounds. It
does NOT enforce round-level invariants (first-launch ack, owner
machine, etc.) — those belong to `run()` (the autonomous loop) and to
auto-advance. This is intentional and matches the spec's separation
between "single-item user-driven advance" and "round-start automated
flow." The follow-up PR will close any gap if a `run()` consumer
discovers one.

### Lock primitive
Over-block: the rename can technically race with another acquirer if
two processes pass the read-then-write window simultaneously. The spec
declares at-most-one-runner-per-machine as a single-process guarantee
(routes hold the call in one promise; runners only spawn from the
supervised AgentServer), so cross-process concurrent acquires are
out-of-band. Documented in the source comment.

Under-block: a runner that crashes between rename and a subsequent
operation leaves a lock file holding its (now-dead) PID. The stale-PID
sweep on the next acquire reclaims it. No alternate path (e.g., file
mtime-based timeout) is needed at this layer.

## Signal vs authority audit

The runner is authority for round-start preflight. It produces a
deterministic `ok|reject` based on verifiable artifacts (tracker
record fields, lock file state, filesystem checks, `gh pr view` via
the existing StageTransitionValidator). No LLM-mediated judgment
lives here — that's the drift checker (signal), which is invoked
separately at step 10 (deferred).

The HTTP routes don't add authority; they thread requests through the
runner / validator. Auth is enforced globally by `authMiddleware`.
OCC is enforced via `If-Match`. The validator's reject codes flow
verbatim to the response — clients see the exact failure mode.

## Interactions with existing systems

- **`InitiativeTracker.update()`.** Halt / ack / accept-partial all
  mutate through update with `ifMatch`, so concurrent writers race
  through the tracker's existing OCC. Bumping the project version
  inside `/advance` (via a no-op `nextCheckAt` self-write) makes the
  next caller see the new version on `GET /projects/:id`.
- **`StageTransitionValidator`.** The drift checker (PR 1) and the
  /advance route (this PR) are the only callers. Validator's slug
  regex + `realpath` jailing protect against path traversal in the
  `specPath` artifact field.
- **`ProjectDigestCache`.** Every mutation (halt, ack, accept-partial,
  advance) goes through the tracker, which calls the digest cache
  invalidator on the write path. Session-start hook reads the updated
  cache on next session bootstrap.
- **Multi-machine.** `machineId` is read from
  `coordinator.identity?.machineId ?? os.hostname()` — same fallback
  the existing PR-coordination code uses. `NOT_OWNER_MACHINE` rejection
  fires if a project record has been claimed by another machine; the
  claim-ownership flow ships in PR 4.
- **No new dependencies.** `proper-lockfile` (already a dep) is NOT
  used here — the round-runner lock is sub-process scoped, where the
  atomic-rename pattern is cheaper and matches the spec's
  machine-local intent.

## Rollback cost

Revert deletes `src/core/ProjectRound{Lock,Runner}.ts`, removes the
ctx field, drops the four routes, drops the test files. Existing
project records carry the optional fields `firstLaunchAckAt`,
`lastAckedRoundIndex`, etc. through unchanged — older code that
doesn't know about them ignores them. No schema migration, no
state-file migrations. The lock file at `.instar/local/round-runner.lock`
becomes orphaned but harmless; subsequent acquires would error
gracefully because no code reads it.

## What this PR explicitly defers (and where it lands)

- **Step 10 of preflight (drift check).** Lands when `POST
  /projects/:id/drift-check` ships with its per-project mutex; the
  cache + ledger from PR 2 are already on disk waiting for a consumer.
- **Autonomous-delegating run loop (`run()`)** with lazy worktrees,
  dynamic stop-condition revalidation, SIGTERM/SIGKILL of process
  groups, partial-complete detection. Round-runner verb scope is
  state-management today; the orchestration loop is the next
  follow-up PR.
- **Auto-advance poller** and **multi-machine claim-ownership**.
  Phase 1b PR 4.
- **`GET /projects/:id/next` real implementation.** Still 501 in PR 3;
  ships alongside `run()`.

## Verification

- `npm run lint` — passes (tsc + lint-no-direct-destructive).
- `npx vitest run tests/unit/ProjectRoundLock.test.ts
  tests/unit/ProjectRoundRunner.test.ts
  tests/integration/projects-api.test.ts` — 61/61 pass (9 lock + 27
  runner + 25 routes).
- Existing PR 1 + PR 2 tests still green (DriftChecker / Cache / Ledger
  tests unaffected — the runner doesn't touch them yet).
