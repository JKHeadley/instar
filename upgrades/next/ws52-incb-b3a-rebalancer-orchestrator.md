# WS5.2 Increment B / B3a — the balancer orchestrator (dark/unwired)

<!-- bump: patch -->

<!--
  NOTE: dark/unwired. One new module (CredentialRebalancer) + its fake-deps unit test.
  The autonomous-write ACTUATION orchestrator that wraps the pure decidePass() core in a
  pass loop and actuates via the gated executor — but it is NOT wired into any runtime
  path (no setInterval, no live route yet). No config flag, no credential write path of
  its own (the executor is the sole write path, itself dark/dry-run-gated). Second-pass
  reviewed (CONCUR).
-->

## What Changed

Adds the stateful orchestrator around the Increment-B decision core — the loop that will eventually run the autonomous balancer, built and tested before it is wired to anything.

- **`CredentialRebalancer.tick()`** (src/core/CredentialRebalancer.ts) — builds the read-only pass snapshot from injected providers, calls `decidePass()`, and actuates each accepted swap through the injected executor wrapper, under the feature's dark/dry-run gate:
  - **Dark = strict no-op:** when the feature is disabled the pass returns immediately having called the providers and the executor ZERO times.
  - **Dry-run actuates the decision but not the write:** the executor enforces dry-run (no credential moves); the pass advances cooldown state so a dry-run soak shows realistic anti-churn cadence.
  - **The executor is the only write path:** a swap rejection is caught and treated as a failure (no crash).
  - **P19 breaker:** N consecutive LIVE failed swaps opens it; a success resets it; it self-heals by re-probing on later passes. A dry-run never trips it.
  - **Cross-pass hysteresis:** cooldown timestamps recorded by the tenant-account pair (matching the policy's cooldown check), the per-window forced-override budget incremented only on a successful wall-override and time-reset.
- **Unwired + dark.** The server `setInterval` pass, the live `GET /credentials/rebalancer` status, and a tick-serialization (reentrancy) guard are the next step <!-- tracked: 20905 -->.

## What to Tell Your User

Still nothing changes — off-by-default internal logic with no effect yet. This is the loop that will eventually run the automatic account-balancer: every few minutes it would look at your quota picture, decide whether a login should move, and carry it out. It's built and tested now, but deliberately not connected to anything that runs on a timer, so it never fires. When it is connected, it stays switched off until you turn it on, and even then a first dry-run mode lets it show what it would do without moving a single credential. There's also a built-in circuit-breaker: if a move ever fails repeatedly, it stops trying and flags it rather than thrashing.

## Summary of New Capabilities

No new runtime capability — the unwired autonomous-write orchestrator for the Increment-B balancer, shipped dark. New internal module `CredentialRebalancer` (`tick()` + `status()`): wraps the pure decision core in a pass loop, actuates via the gated executor under the dark/dry-run gate, carries cross-pass cooldown state + a P19 breaker. Not wired into any runtime path; no route, no config flag, no credential write path of its own.

## Evidence

- `tests/unit/credential-rebalancer.test.ts` (7) — dark = strict no-op (zero executor calls); actuates one swap for a walling scenario; dry-run drives the executor (no-op write) and advances cooldowns; the per-pair cooldown holds a re-swap on the next pass; the P19 breaker opens after 3 consecutive live failures and resets on a success; a dry-run ok never trips the breaker; the status surface reports enabled + breaker + last pass. Independent second-pass review CONCUR. tsc + full lint clean.
