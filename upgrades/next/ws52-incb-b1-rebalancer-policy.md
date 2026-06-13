# WS5.2 Increment B / B1 — the balancer decision core (dark/unwired)

<!-- bump: patch -->

<!--
  NOTE: dark/unwired pure logic. One new module (CredentialRebalancerPolicy) + its
  exhaustive unit test. NOT wired into any runtime path — it is the §2.4 decision core
  for the autonomous drainer (Increment B). Zero IO, no config flag, no route, no
  credential write path. The actuation that consumes its output is a later step under
  the existing subscriptionPool.credentialRepointing dark/dry-run gate.
-->

## What Changed

Begins Increment B (the autonomous use-it-or-lose-it drainer) with its decision core, deliberately split out so the entire policy is unit-testable before any autonomous write exists.

- **`CredentialRebalancerPolicy.decidePass()`** (src/core/CredentialRebalancerPolicy.ts) — a PURE function computing the zero-or-more credential swaps for one balancer pass from a read-only snapshot (per-account quota + reset proximity, per-slot tenancy/verify/activity, cooldown state, resolved config):
  - **Objective 1 — wall avoidance:** a tenant over the high-water mark (default 85%, either window) gets the highest-headroom eligible account; a tenant over the critical mark (default 95%) triggers a wall-OVERRIDE that bypasses the cooldowns and the 1-swap/pass cap — itself bounded by the fresh-data gate (never re-fires on the same sensor snapshot), `maxForcedSwapsPerPass`, and a per-window override budget whose exhaustion surfaces a degraded + attention terminal state instead of looping. The rescue target must be verified-recent (the recency gate).
  - **Objective 2 — use-it-or-lose-it drain:** an account whose WEEKLY window resets within the horizon with ≥30% unused headroom is dealt to the busiest eligible slot (weekly only — 5h windows regenerate); a per-slot "drain in progress" hold stops the 3-way drain rotation from fragmenting the window.
  - **Eligibility + hysteresis:** needs-reauth/disabled/quarantined/unverified never participate; stale-quota accounts are SOURCE-only; per-pair + per-tenant cooldowns (the tenant cooldown defeats the 3-way rotation attack); a min-improvement floor with urgency clamped at 4h-to-reset; 1 swap per pass for non-forced objectives.
- **Unwired + dark.** Nothing actuates on the decision yet. Dead-default eviction, the correlated-oracle-outage floor, quarantine-exit, the P19 breaker, and the scheduled identity audit are the next Increment-B step <!-- tracked: 20905 -->; wiring the decision through the live executor (under the existing `subscriptionPool.credentialRepointing` dark/dry-run gate), the live `GET /credentials/rebalancer` status, and the routes follow <!-- tracked: 20905 -->.

## What to Tell Your User

Nothing changes — this is off-by-default internal logic with no effect yet. It's the "brain" of the eventual automatic account-balancer: given how much quota each of your accounts has left and how close each is to its weekly reset, it works out whether to shuffle one account's login to a different slot to (a) rescue a session about to hit a wall, or (b) burn down a weekly allowance that would otherwise expire unused. Right now it only *decides* — nothing acts on those decisions, so no credential moves. It's built first and on its own precisely so every rule can be tested in isolation before anything is ever wired to actually move a login, and the whole balancer stays switched off until you decide otherwise.

## Summary of New Capabilities

No new runtime capability — this is the unwired decision core for the autonomous balancer (Increment B), shipped dark. New internal module `CredentialRebalancerPolicy` (pure `decidePass()`): computes the per-pass wall-avoidance / drain / default-preference swap decisions with bounded wall-override, eligibility, and hysteresis. Not wired into any runtime path; no route, no config flag, no credential write path.

## Evidence

- `tests/unit/credential-rebalancer-policy.test.ts` (18) — eligibility (needs-reauth tenant excluded; quarantined slot not a target); wall avoidance (rescue with highest-headroom; no rescue when only target also walls; held behind per-pair cooldown; triggers on the weekly window too); wall-override (bypasses cooldown; fresh-data gate no-re-fire; per-window budget exhaustion → degraded + attention; ≤ maxForcedSwapsPerPass when multiple critical; recency gate rejects a stale-verify target); stale-quota source-only; drain (weekly-only, headroom floor, drain-in-progress hold excluded, busiest-slot destination); zero-actuation reason; 1-swap-per-pass. tsc + full lint clean.
