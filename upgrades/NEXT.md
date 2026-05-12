# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

### Project-scope Phase 1b PR 3 — round runner + halt/advance/ack endpoints

Third PR of project-scope Phase 1b. Ships the single-chokepoint
runner that the spec names in § Phase 1.5, plus the four mutating
HTTP routes that thread through it:

- `POST /projects/:id/advance` — single-item stage transition driven
  by the existing `StageTransitionValidator`. Requires `If-Match`
  (OCC). Body: `{itemId, targetStage, artifact: {specPath?, prNumber?,
  taskFlowRecordId?, skippedReason?, skippedBy?, unskippedAt?}}`.
  Returns 409 with `{error, code, reason}` on validator reject.
- `POST /projects/:id/halt` — emergency stop. Writes `haltedAt` +
  `haltReason` to the active round, releases the round-runner lock
  if the calling machine holds it. Idempotent.
- `POST /projects/:id/ack` — records user acknowledgment for a round.
  Populates `firstLaunchAckAt` if absent, advances
  `lastAckedRoundIndex`, resets `unacknowledgedAdvanceCount`.
  Idempotent on `forRoundIndex`.
- `POST /projects/:id/accept-partial` — closes a partially-complete
  round. Non-merged, non-skipped child items transition to
  `skipped` (requires `reason` + `skippedBy` per the validator);
  round status → `complete-with-skips`; counts as ack for the
  current `roundIndex`.

Behind the routes: `ProjectRoundRunner` runs the 9 deterministic
preflight checks from § Phase 1.5 (lock free, round shape valid,
items resolve, first-launch ack on round 0, unacked-advances cap,
ack-gap cap, owner machine matches, target repo is a git repo, no
pending reconciliation conflicts). Drift check (step 10) is
intentionally deferred until the drift-check HTTP endpoint and its
cache + ledger wiring ship in a follow-up PR — the drift verdict
cache and cost ledger from v0.28.94 are on disk waiting for that
consumer.

The autonomous-delegating `run()` loop (lazy worktrees, dynamic
stop-condition revalidation, SIGTERM/SIGKILL of process groups,
partial-complete detection) is also deferred to the next PR; this
PR ships the state-management verbs without the orchestration loop
so the routes can be exercised end-to-end against real validators
today.

Lock primitive lives at `.instar/local/round-runner.lock` —
machine-local (not git-synced) per spec. `O_CREAT|O_EXCL` rename +
stale-PID sweep on every acquire, so a crashed runner doesn't
permanently block subsequent acquires.

## What to Tell Your User

- **You can now drive a project round through the HTTP layer**: I can
  advance a single item one stage with a real artifact check, halt the
  active round on demand, record acknowledgment when I've shown you a
  digest, or close out a round that landed only some of its items —
  all from the dashboard or directly through the API. The actual
  autonomous round loop that walks through items one by one is the
  next piece I'm building.

## Summary of New Capabilities

- `ProjectRoundRunner` class — single chokepoint for round-start.
  `preflight(projectId, roundIndex)` runs deterministic checks and
  returns a structured `PreflightResult`. `halt`, `recordAck`,
  `acceptPartial` are idempotent state-management verbs that mutate
  through `InitiativeTracker.update()` with OCC. Static
  `validateChildFrontmatter` for callers that need to assert
  `review-convergence: true` AND `approved: true` outside the runner.
- `ProjectRoundLock` class — machine-local mutex at
  `.instar/local/round-runner.lock`. Atomic acquire via rename,
  stale-PID sweep on every call. Exposes `acquire`, `release`, `read`.
- New HTTP routes: `POST /projects/:id/advance`,
  `POST /projects/:id/halt`, `POST /projects/:id/ack`,
  `POST /projects/:id/accept-partial`. All require Bearer auth;
  `/advance` requires `If-Match`.
- `RouteContext.projectRoundRunner` — wired from
  `AgentServer({ projectRoundRunner })` so other future routes (drift
  check, run-round, claim-ownership) can route through the same
  runner instance.
