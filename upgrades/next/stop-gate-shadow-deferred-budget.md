# Stop gate: shadow-mode judgments are recorded again

## What Changed

- `src/core/UnjustifiedStopGate.ts`: `evaluate(input, options?)` takes `timeoutMs` (can only lengthen the 2 s default, capped at 60 s) and `onProviderSettled` (fires once when the provider call really ends; a timeout does not cancel it).
- `src/server/routes.ts` (`/internal/stop-gate/evaluate`): in `shadow` mode the route answers the Stop hook at once (`allow`) and judges on a 30 s budget, recording the row when the verdict returns. At most 4 shadow provider calls run at once; a stop past that is answered `shadow-capacity`, not judged, and counted on `GET /internal/stop-gate/log` (`shadow.inFlight`, `shadow.skippedAtCapacity`). `enforce` mode is unchanged.

Why: the 2 s budget exists because enforce mode makes the session wait for the verdict. Shadow mode never acts on the verdict, but used the same budget. On an agent whose gate calls run off-Claude (Codex, p50 ~4.7 s, fastest observed 2.005 s), every call timed out, the gate's breaker stayed open from 2026-08-20, and the Turn-End Self-Deferral Guard's shadow soak recorded nothing for two months (7,408 consecutive failures). The breaker resets on the first successful judgment after this ships.

## What to Tell Your User

None — internal change. The background check that watches for the agent handing its own work back to you was silently not recording anything; it records again. Stops in that trial mode also finish a little faster.

## Summary of New Capabilities

None — internal fix, no new surface.

## Evidence

`tests/unit/UnjustifiedStopGate-call-budget.test.ts` (8) and `tests/integration/stop-gate-shadow-deferred-budget.test.ts` (5, real `createRoutes`): a shadow call slower than the default budget is answered at once and its verdict recorded with the self-deferral columns; enforce mode still times out; malformed verdicts record failure rows; the concurrency cap holds slots until provider calls really end. Reverting `src/` makes 3 of the 4 original integration tests fail. Live measurement: Echo `feature-metrics.db`, 1,253 calls/7 days, min latency 2,005 ms, 0 under 2,000 ms; `stop-gate.db` `events` 0 rows.
