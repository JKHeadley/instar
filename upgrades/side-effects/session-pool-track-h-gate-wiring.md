# Side effects — Track H part 2b: rollout-gate boot wiring + GET /session-pool/e2e-results (§Rollout)

## What this adds
Wires the rollout gate into the live server (still dark — inert until the pool activates).
- `src/commands/server.ts` — constructs `SessionPoolE2EResultStore` (HMAC-signed over the agent authToken, file `state/session-pool-e2e-results.json`) + a `StageAdvancer` whose `writeStageConfig` routes through `liveConfig.set(STAGE_CONFIG_PATH, stage, { stageWriteToken })` — the sole stage write path. Passed to AgentServer.
- `src/server/routes.ts` — `GET /session-pool/e2e-results` (Bearer-auth like all routes): latest result per stage + per-row verify + total history count; 503 when the gate is dark/absent. RouteContext gains `sessionPoolE2EResultStore?`.
- `src/server/AgentServer.ts` — passthrough option → routeCtx.

## Risk / blast radius
None — the store is read-only over the route; StageAdvancer is constructed but not driven yet (the rollout job that calls advanceTo/reconcile is a later step). The stage-write path is guarded (Track H part 2a). No behavior change while dark.

## Tests
- `tests/integration/session-pool-e2e-results-route.test.ts` — 2: 503 when dark; 200 with latest-per-stage + verification + append-only total over a real store + real route.
- (units from part 1/2a: StageAdvancer 9, E2EResultStore 5, stageWriteGuard 6 — all green.)

## Follow-ups (Track H)
The rollout job/tick that drives StageAdvancer.advanceTo/reconcile; the CI release-boundary check; rebalance; live-ingress interception + outbound mesh client (D11 activation); real-hardware + test-as-self proof.
