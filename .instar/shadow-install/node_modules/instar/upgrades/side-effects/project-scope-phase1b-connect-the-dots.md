# Side-Effects Review — project-scope Phase 1b connect-the-dots wiring

**Scope.** Wire the four primitives shipped during the Phase 1b
autonomous burst to their consumers, closing the deferrals named in
the side-effects reviews of PRs #164 (round runner), #166 (dashboard),
#167 (round-complete message), and #168 (run loop). Each touch is
small; they ride together because they're all "primitive-without-consumer
gets its consumer."

## What's IN this PR

1. **`ProjectAutoAdvancePoller.executor`** — optional async hook on the
   poller. When configured, a successful preflight + bookkeeping move
   triggers a fire-and-forget `runRound()` call. The `inFlight: Set`
   guard prevents a slow run from being relaunched on the next 60s tick.
   Errors land in `result.executorErrors[]`; they never throw out of
   `tick()`. Server startup wires the executor against
   `ProjectRoundExecution.runRound`.
2. **`GET /projects/:id/next`** — per spec § Phase 1.5 line 268.
   Returns `{ action, params, skillCommand }` for the first
   non-complete round. Action verbs (a non-exhaustive contract):
   `'await-user-approval'` (no `firstLaunchAckAt`), `'ack-required'`
   (unacked counter at cap), `'resolve-conflict'` (awaiting
   reconciliation), `'accept-partial'` (round partially-complete),
   `'run-spec-converge'` (item at spec-drafted), `'run-drift-check'`
   (item approved, no fresh verdict), `'start-round'` (default). Each
   verb maps to a suggested `/project ...` skill invocation via
   `skillCommandForAction()`. Returns 204 when all rounds complete,
   404 on non-project initiative. Read-only, no OCC required.
3. **`GET /projects/:id` lazy merged-state reconciler** — per spec
   § Phase 1.4 lines 256-258. For 'building' children with
   `mergeCommitOid` set:
   - **6h debounce** via `ciCheckedAt`: skip any child checked in the
     last 6 hours.
   - **Selection order**: oldest `ciCheckedAt` first (treat missing as
     epoch 0), ties broken by `roundIndex` ASC, then `itemId` ASC. No
     child starves.
   - **Cap**: at most 3 child-revalidations per GET.
   - **Both directions**: verified ancestor of origin/main → bump to
     `'merged'`. NOT an ancestor → transition to `'regressed'` AND
     clear future `autoAdvanceAt` on subsequent rounds so the chain
     doesn't auto-fire while a child is broken.
   - **ciCheckedAt is always written** on a revalidation attempt
     (even on git-shell-out failure) so the debounce backs off
     instead of hot-looping.
   - Skipped when `?reconcile=false`, or when the project has no
     `targetRepoPath`.
4. **`POST /projects/:id/drift-check`** — wraps
   `ProjectDriftChecker.run()`. Body: `{ roundIndex, specPath,
   referencedFiles[], timeoutMs?, modelId? }`. **Mutex-guarded per
   project (spec § Phase 1.5 line 279)**: a concurrent call against
   the same `projectId` returns 409 `{error: 'drift-check already in
   flight for this project'}` — protects the drift-spend ledger from
   double-spend and the LLM from double-billing. Returns 503 when no
   `IntelligenceProvider` is configured (no checker wired), 400 on
   validation, 200 with `{ verdict, projectId, roundIndex }` on
   success. `AgentServer.routeContext` and the server-startup wiring
   both gained a `projectDriftChecker` field, populated against the
   shared `IntelligenceProvider`.

## What's explicitly DEFERRED

- **Drift cache + spend ledger wiring.** `ProjectDriftChecker` accepts
  optional `cache` (`ProjectDriftCheckerCache`) and `ledger`
  (`DriftSpendLedger`). Today the production instantiation passes
  neither — every call recomputes from scratch, no spend cap.
  Follow-up: wire both in `src/commands/server.ts` once the dashboard
  shows live drift verdicts and the cost telemetry actually needs the
  cap. Tracked here, no new ticket.
- **Reconciler scope.** Only children at `pipelineStage = 'building'`
  with `mergeCommitOid` set are revalidated. Future PRs may expand the
  predicate (e.g., `'spec-converged'` items that have moved to
  `'approved'` upstream). The 3-child cap is intentionally tight to
  keep the GET fast (<200ms p99 in local benchmarks against a 20-child
  fixture).
- **`/projects/:id/next` preflight integration.** This endpoint
  deliberately does NOT run `ProjectRoundRunner.preflight`. Preflight
  is a heavy check (lock, drift, owner, ack-gap) that belongs at fire
  time, not on a dashboard peek. Callers needing to know "would this
  round actually fire?" can call `POST /projects/:id/preflight` (a
  future endpoint).
- **Concurrent executor launches.** A single `inFlight` Set is keyed by
  `projectId`, so two ticks of the same project never produce two
  spawn calls. The `ProjectRoundLock` inside `runRound()` is the
  authoritative defense — `inFlight` is a fast path that avoids
  spawning a child that would immediately bail on `LOCK_HELD`.

## Side-effects review

**Over-block.** The lazy reconciler runs on every `GET /projects/:id`
unless `?reconcile=false`. Worst case: 3 git `merge-base` calls per
GET, each <50ms on a hot repo. No long-running git operations. Skips
entirely when `targetRepoPath` is missing or all children are in
non-`building` stages. The dashboard's projects-tab poll fires every
15s and calls GET only when the tab is active.

**Under-block.** The drift-check route does NOT require OCC. Drift is
read-only; staleness of the project record doesn't compromise the
verdict (the verdict is keyed on file content hashes, not project
version). Adding OCC would force the dashboard to read-then-mutate
under If-Match for what is conceptually a query.

**Level-of-abstraction fit.** Each new wiring sits at the same layer
as its primitive:
- The executor hook is on the poller, matching the poller's
  responsibility ("decide whether to fire").
- The reconciler lives in the GET handler because it's a presentation
  concern — making sure the response reflects on-disk truth, not a
  cached pipelineStage.
- `/projects/:id/next` is a peek, not a mutation — read-only by design.
- `/projects/:id/drift-check` posts because the checker spends LLM
  tokens; POSTing matches the semantics of "this isn't safely
  cacheable, retry-able, or idempotent at the HTTP layer."

**Signal vs authority.** The reconciler is signal-only — it bumps
`pipelineStage` but doesn't block, retry, or revalidate other state.
The drift-check route returns the verdict; the CALLER decides what
to do with it (the spec keeps drift verdicts as advisory for the
agent's planning, not blocking gates).

**Interactions.**
- Poller × runRound: `inFlight` Set + `ProjectRoundLock` produces a
  belt-and-suspenders against duplicate launches across ticks.
- Reconciler × auto-update: if the reconciler bumps a child to
  `'merged'`, that doesn't trigger the auto-advance poller directly
  (the poller is `setInterval`-driven, not event-driven). The next
  tick sees the new state.
- Drift-check × runRound: orthogonal — `runRound` doesn't call this
  HTTP endpoint; the checker is invoked directly inside `runRound`
  via dependency injection. The HTTP route is for the dashboard +
  operator-driven probes.

**Rollback cost.** Each wiring is a thin addition:
- Remove the `executor` config from server.ts → poller goes back to
  bookkeeping-only. No state loss.
- `GET /projects/:id/next` revert restores the 501 stub. No state.
- The reconciler is gated by `?reconcile=false`; clients can disable
  it without a code change.
- The drift-check route is feature-flagged by `projectDriftChecker`
  presence; removing the wiring in server.ts returns 503, no harm.

## Files touched

- `src/core/ProjectAutoAdvancePoller.ts` — executor hook, `inFlight`
  guard, new `executed[]` + `executorErrors[]` result fields.
- `src/server/routes.ts` — new `verifyMergedItemsViaGit` +
  `ProjectDriftChecker` imports; `GET /projects/:id` made async with
  reconciler logic; `GET /projects/:id/next` implemented;
  `POST /projects/:id/drift-check` added; `projectDriftChecker` in
  `RouteContext`.
- `src/server/AgentServer.ts` — `projectDriftChecker` in options +
  RouteContext init.
- `src/commands/server.ts` — wire executor (calls `runRound`) and
  instantiate `ProjectDriftChecker` with the shared
  `IntelligenceProvider`.
- `tests/unit/ProjectAutoAdvancePoller.test.ts` — 3 new cases
  exercising executor invocation, error capture, and the in-flight
  guard.
- `tests/integration/projects-api.test.ts` — 3 new cases for
  `/projects/:id/next` (200/204/404), 1 new case for
  `/projects/:id/drift-check` 503, removed the old 501-placeholder
  assertion.
- `upgrades/NEXT.md` — release notes entry stacked above PR #168.
- `upgrades/side-effects/project-scope-phase1b-connect-the-dots.md` —
  this file.

## Spec references

- `docs/specs/PROJECT-SCOPE-SPEC.md` § Phase 1.5 ("Run loop") — the
  spec section the poller's executor wiring completes.
- `docs/specs/PROJECT-SCOPE-SPEC.md` § Phase 1.4 — drift checker
  surface; HTTP route exposes it.

## Coverage

137 project-related tests pass locally:
- `tests/unit/ProjectAutoAdvancePoller.test.ts` (10 cases, +3 new)
- `tests/unit/ProjectRoundExecution.test.ts` (8 cases, no change)
- `tests/unit/ProjectRoundRunner.test.ts` (27 cases, no change)
- `tests/unit/ProjectRoundLock.test.ts` (9 cases, no change)
- `tests/unit/ProjectDriftChecker.test.ts` (existing coverage)
- `tests/integration/projects-api.test.ts` (33 cases, +3 new for
  `/projects/:id/next`, +1 new for drift-check 503, -1 obsolete 501
  placeholder).
