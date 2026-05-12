# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

### Project-scope Phase 1b connect-the-dots — wire the primitives

Wires the four primitives shipped during the Phase 1b autonomous burst
to their consumers, closing the deferrals named in side-effects reviews
of PRs #164, #166, #167, and #168.

- **Auto-advance poller now actually launches rounds.** On a successful
  preflight + bookkeeping move, the poller fires-and-forgets a
  `ProjectRoundExecution.runRound()` call. A per-project `inFlight`
  guard prevents a slow run from being relaunched on the next 60s
  tick. Errors are captured in `result.executorErrors[]` — they never
  throw out of `tick()`.
- **`GET /projects/:id/next` returns a structured action.** Replaces
  the 501 placeholder with the spec § 1.5 line 268 contract:
  `{ action, params, skillCommand }`. Verbs include
  `'await-user-approval'`, `'ack-required'`, `'resolve-conflict'`,
  `'accept-partial'`, `'run-spec-converge'`, `'run-drift-check'`,
  `'start-round'`. Each maps to a `/project ...` invocation so the
  dashboard + skill UI can act on a single GET. 204 when all rounds
  complete, 404 on non-project initiative.
- **`GET /projects/:id` lazy reconciler.** Per spec § 1.4 lines 256-258.
  For 'building' children with `mergeCommitOid` set: 6h debounce via
  `ciCheckedAt`, selection order oldest-`ciCheckedAt`-first
  (ties → `roundIndex` ASC → `itemId` ASC, no starvation), cap of 3
  per GET. Verified ancestor of `origin/main` → `'merged'`. NOT an
  ancestor → `'regressed'` AND clear future `autoAdvanceAt` so the
  chain doesn't auto-fire while a child is broken. `ciCheckedAt` is
  written on every revalidation attempt (success or git failure) so
  the debounce always backs off. Opt-out: `?reconcile=false`.
- **`POST /projects/:id/drift-check` route.** New HTTP wrapper around
  `ProjectDriftChecker.run()`. **Mutex-guarded per project (spec line
  279)** — concurrent calls against the same project return 409,
  protecting the drift-spend ledger from double-spend. Body:
  `{ roundIndex, specPath, referencedFiles[], timeoutMs?, modelId? }`.
  Returns 503 when no `IntelligenceProvider` is configured.

Drift cache + spend-ledger wiring are intentionally deferred until the
dashboard surfaces live verdicts and cost telemetry needs the cap. The
mutex is in-process per-server; multi-process protection comes from
the existing `proper-lockfile` on the drift-spend ledger itself.

### Project-scope Phase 1b PR 7 — autonomous run loop

Final PR of project-scope Phase 1b. Ships the autonomous run loop the
spec § Phase 1.5 names (steps 1-11), wired against the lock, preflight,
and runner primitives that landed in PRs 3-6:

- **`ProjectRoundWorktrees`** — lazy worktree allocator under
  `<targetRepoPath>/.worktrees/<projectId>/<roundIndex>/<itemId>`.
  Appends `.worktrees/` to `.git/info/exclude` on first allocation so
  the namespace doesn't pollute `git status`. Helpers for prune +
  remove + ensure-exclude-entry.
- **`runRound(input, deps)`** — the run loop itself. Acquires the
  round-runner lock, lazily allocates the first worktree, spawns the
  autonomous child in a detached process group, polls the project
  record every 60 seconds. On mid-round mutation to `round.itemIds`,
  SIGTERMs the child's process group (5s grace, then SIGKILL) and
  relaunches with the new stop condition. On the child's natural
  exit, verifies per-item artifacts via the caller-injected
  `verifyMergedItems` and sets `round.status` to `complete` or
  `partially-complete`. On `haltedAt` set mid-run, kills the child
  and returns `halted`. Three-attempt resume cap on transient
  non-zero exits before `failed`.
- **`verifyMergedItemsViaGit`** — exported helper for production
  callers; runs `git merge-base --is-ancestor <child.mergeCommitOid>
  origin/main` per item.

The run loop is a module function, not a method on `ProjectRoundRunner`,
because it has different lifecycle semantics (long-running, subprocess
manager) than the synchronous verbs in PR 3's runner. Both modules
work in concert: callers call `runner.preflight(...)` first, then
`runRound(...)` if preflight passes.

Phase 1b is now fully decomposed: 7 PRs across drift + cache + ledger
+ runner + halt/advance/ack + auto-advance + claim-ownership +
dashboard + filter + round-complete-message + run-loop. The remaining
spec items (lazy merged-state reconciler on GET, `GET /next` real
implementation) are wiring tasks rather than new infrastructure.

### Project-scope Phase 1b PR 6 — tone-gated round-complete message + delivery

Sixth PR of project-scope Phase 1b. Ships the two final primitives the
autonomous run loop will need to emit round-complete digests safely:

- **`formatRoundCompleteMessage(input)`** — pure template function.
  Enforces required-field PRESENCE (not non-emptiness, per spec —
  "the gate never silently rejects on a legitimate halt"). Returns
  `{ok:true, message, idempotencyKey}` or `{ok:false, missingFields}`.
  Halt-flavor events additionally require `whatHalted`.

- **`RoundCompleteDeliveryHelper`** — retry + idempotency wrapper.
  3-attempt exponential backoff (1s, 2s, 4s by default). Records
  the `(projectId, roundIndex, eventKind, projectVersion)` key in
  `.instar/local/round-complete-sent.json` after the first successful
  send so tone-gate retries don't produce duplicates. On permanent
  failure, fires the caller's `onPermanentFail` callback (the run
  loop will wire it to attention-queue + audit-log + awaitingUser
  population when it ships).

Nothing wires these up yet — the autonomous run loop is the consumer.
PR 6 ships the primitives so the run loop in a follow-up PR doesn't
fork either of them.

### Project-scope Phase 1b PR 5 — dashboard Projects tab + Initiatives filter

Fifth PR of project-scope Phase 1b. Ships the dashboard view of the
project surface and the small server-side filter the dashboard depends
on:

- **Projects tab** in the dashboard. Read-only card per active project
  with title + id + version + drift status badge + per-round progress
  bar + pipelineStage histogram. Halt + Ack buttons route through the
  PR 3 endpoints; 409 responses silently re-render (no error toast).
  15-second poll while the tab is active; cleared on deactivation.
  XSS-safe — every rendered string goes through `textContent`, no
  `innerHTML`.
- **Initiatives tab filter** — by default the tab now hides
  project-kind records (shown in their own Projects tab) and child
  initiatives of any project (shown inside the parent's card). A
  "Show projects + children" checkbox bypasses the filter for users
  who want the full list. The filter is server-side: the records
  never cross the wire when excluded.
- **`GET /initiatives` filter params** — accepts `excludeKind=<kind>`
  (drops records of that kind) and `excludeParented=true` (drops
  records that are children of any project). Additive — existing
  callers see no behavior change.

The compaction-recovery hook's active-projects digest was already in
the template (it shipped alongside session-start.sh in PR 1's Phase
1.9 work), so no template change is needed here.

### Project-scope Phase 1b PR 4 — auto-advance poller + multi-machine claim-ownership

Fourth PR of project-scope Phase 1b. Ships three pieces:

- **`MachineHeartbeat`** — per-machine liveness signal at
  `.instar/machine-health/<machineId>.json` (git-synced). Written
  every 30 minutes; consulted by the claim-ownership flow for the
  48-hour staleness check. Machine ids with weird characters are
  URL-encoded into the file name so a stray slash cannot escape
  `.instar/machine-health/`.

- **`ProjectAutoAdvancePoller`** — periodic scan (1-minute tick) for
  project rounds whose `autoAdvanceAt` has elapsed. Server-side
  filter: `kind:'project'`, `status:'active'`, owner machine matches
  current, `unacknowledgedAdvanceCount < 2`. On fire, calls
  `ProjectRoundRunner.preflight`; structural rejects (first-launch
  ack missing, cap hit, project inactive, etc.) clear `autoAdvanceAt`
  to prevent re-firing on every tick.

- **`POST /projects/:id/claim-ownership`** — OCC-protected
  multi-machine ownership transfer. Refuses with 409 when the current
  owner has a fresh heartbeat unless `{force:true}` is passed.
  Idempotent on already-owns. Response carries `previousOwner` for
  audit.

Plus a one-shot **post-restore reconciler** at server startup: any
project round flagged `in-progress` is downgraded to `pending`. The
previous owner may have crashed or migrated; no TaskFlow yet exists
to verify whether a child is actually live.

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

- **The autonomous round loop is wired up end-to-end**: when a round
  starts, I now spawn the actual autonomous work in its own process
  group, watch every minute for changes to which items the round is
  working on, and clean up after myself (process group + worktrees)
  when I am done or you halt me. If you manually skip an item or
  re-order the round mid-run, I gracefully stop the work I am doing
  and relaunch with the new plan — no orphaned compilers, no
  orphaned worktrees.

- **Round-complete digests are duplicate-safe**: when I finish a
  round, the message I send you is built from a template that refuses
  to send if any required field is missing, and the delivery layer
  remembers what it already sent so a tone-gate retry can't spam you
  with the same digest twice. If delivery fails permanently, I will
  surface it through your attention queue rather than retry forever
  in silence.

- **Projects have a dashboard tab now**: open the dashboard and you'll
  see every active project I'm tracking with its round-by-round
  progress, which items have merged vs which are still in flight, and
  any drift warnings I've recorded. Halt and ack buttons are right
  there if you want to stop me or tell me you've seen the digest. The
  Initiatives tab no longer mixes project plumbing in by default —
  flip the "Show projects + children" toggle if you want to see
  everything together.

- **You can now drive a project round through the HTTP layer**: I can
  advance a single item one stage with a real artifact check, halt the
  active round on demand, record acknowledgment when I've shown you a
  digest, or close out a round that landed only some of its items —
  all from the dashboard or directly through the API. The actual
  autonomous round loop that walks through items one by one is the
  next piece I'm building.

- **I can recover ownership when a peer machine goes offline**: if my
  other machine has been silent for more than 48 hours, I can claim
  back ownership of a project we'd been working on together. If my
  peer is still online, I will refuse the claim unless you tell me to
  force it.

- **Time-based auto-advance is wired up**: when a round completes
  cleanly, I will schedule the next round automatically. If you have
  asked me to pause and have not acked, I will not auto-advance again
  until you do — the two-rounds-ahead-without-ack brake stops me from
  running off on my own.

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
- `MachineHeartbeat` class — `start()` / `stop()` / `writeOnce()` /
  `read(machineId)` / `isStale(machineId)` / `listAll()`. File-backed,
  git-syncable, defense-in-depth on malformed reads.
- `ProjectAutoAdvancePoller` class — `tick()` returns a structured
  `{scanned, fired, rejected, cleared}` report. Caller-driven cadence;
  server wires a 60-second interval.
- `POST /projects/:id/claim-ownership` — body `{force?: boolean}`;
  header `If-Match` (OCC). Returns 200 with
  `{ownerMachineId, previousOwner, version}` on success; 409 on fresh
  peer heartbeat or version mismatch.
- `RouteContext.machineHeartbeat` — bundled `{api, config}` so the
  claim-ownership route can compare against the local machine id
  without an extra top-level ctx field.
- Server startup runs a one-shot reconciler that downgrades any
  `in-progress` round to `pending`. Best-effort; OCC races are
  silently retried on subsequent reconciler passes (or via the
  auto-advance poller's filter).
- Dashboard `Projects` tab — read-only project cards with progress
  bar + drift badge + halt/ack buttons. 15-second poll while active.
- Dashboard `Initiatives` tab now defaults to hiding project-kind +
  child records. "Show projects + children" checkbox bypasses.
- `GET /initiatives` accepts new optional query params: `excludeKind`
  (drops records where `kind ?? 'task'` matches) and
  `excludeParented=true` (drops records with a `parentProjectId`).
  Additive; existing clients see no behavior change.
- `formatRoundCompleteMessage(input)` — pure template function with
  required-field PRESENCE gate (empty strings accepted, undefined
  rejected). Halt-flavor events additionally require `whatHalted`.
  Returns `{message, idempotencyKey}` on success.
- `ProjectRoundWorktrees` class — lazy worktree allocator under
  `<targetRepoPath>/.worktrees/<projectId>/<roundIndex>/<itemId>`.
  Static `pathFor`/`allocate`/`prune`/`remove`/`ensureExcludeEntry`.
- `runRound(input, deps)` function — the run loop. Acquires lock,
  spawns autonomous child detached, polls every 60s, SIGTERMs on
  dynamic-stop changes or halt, verifies per-item artifacts on
  natural exit, sets `round.status`. Returns
  `{outcome, mergedItemIds, unmergedItemIds, relaunchCount,
  resumeAttempts, reason}`.
- `verifyMergedItemsViaGit(targetRepoPath, childIds, tracker)` —
  exported production verifier; checks `git merge-base --is-ancestor
  <child.mergeCommitOid> origin/main` per item.
- `RoundCompleteDeliveryHelper` class — retry + idempotency wrapper.
  3-attempt exponential backoff (configurable); records the
  idempotency key in `.instar/local/round-complete-sent.json` so
  duplicate sends are suppressed. `onPermanentFail` callback fires
  once when all retries are exhausted.
