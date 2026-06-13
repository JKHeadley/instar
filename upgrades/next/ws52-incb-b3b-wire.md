# WS5.2 Increment B / B3b-wire — balancer wired into the server (dry-run on dev)

<!-- bump: patch -->

<!--
  NOTE: wires the already-reviewed CredentialRebalancer orchestrator into the server
  composition root + a reentrancy-guarded setInterval pass + the GET /credentials/rebalancer
  status surface. Because the feature is re-gated live-on-dev-in-dry-run, the balancer now RUNS
  on a dev agent every ~5min in dry-run (full decision loop + audit, ZERO credential writes);
  the fleet is a strict no-op. No new write authority (the executor's dryRun is the write guard).
  Second-pass reviewed (CONCUR).
-->

## What Changed

Makes the autonomous balancer actually run — on a development agent, in dry-run — so it dogfoods its decisions instead of sitting as unwired code.

- **Wired into the server** — the `CredentialRebalancer` is constructed in the credential-repointing bundle with the snapshot-mapper providers (ledger → slots, subscription pool → accounts, config resolver) and an `isEnabled` that mirrors the location gate exactly (dev-gate-resolved AND not env-token-refused). A reentrancy-guarded, interval-clamped (`[60s, 60min]`), `.unref()`'d `setInterval` runs the pass; tick errors are caught so a throw never crashes the loop.
- **Live status surface** — `GET /credentials/rebalancer` now reports `balancerWired:true` + `rebalancer.status()` (enabled, the P19 breaker state, cooldown counts, and the last pass's decisions/degraded/attention) when the feature is live, scrubbed via the audit chokepoint; it stays a strict 503 no-op while dark.
- **Dry-run dogfood, zero writes** — on a dev agent the loop runs the full decision loop and audits what it WOULD do, but the executor's `dryRun` default keeps every credential write off until a deliberate `dryRun:false`.

## What to Tell Your User

The automatic account-balancer is now actually running on me — but in dry-run, so it's all observation, no action. Every few minutes it looks at your quota picture, decides whether a login should move, and records what it WOULD do — moving zero real credentials. You can watch it at the rebalancer status endpoint (which account it would shuffle and why, plus its safety circuit-breaker). It only runs on a development agent like me (your wider fleet stays dark), and the step where it actually starts moving logins is still your deliberate switch, after the livetest. This is the dogfooding rung of the maturity path — it's live and watchable, with nothing irreversible happening.

## Summary of New Capabilities

The autonomous balancer (Increment B) is now wired + running in dry-run on a development agent. `GET /credentials/rebalancer` reports the live balancer status (last pass + P19 breaker). On a dev agent the balancer pass runs every ~5min (interval-clamped, reentrancy-guarded) computing + auditing its decisions; zero credential writes while `dryRun` holds (the default). The fleet stays dark (strict 503/no-op). No new write authority — the executor's dry-run gate is the load-bearing write guard.

## Evidence

- `tests/e2e/credential-repointing-routes-alive.test.ts` (6) — the rebalancer route now surfaces `balancerWired:true` + the live `rebalancer.status()` (enabled + breaker) on a production-shaped bundle with a real wired CredentialRebalancer; the dark path still 503s (strict no-op). tsc + full lint clean. Independent second-pass review CONCUR (gate mirrors the location gate; dry-run defaults true with the executor as the write guard; timer reentrancy-guarded/clamped/unref'd/error-caught; route is a leak-free 503-while-dark surface).
