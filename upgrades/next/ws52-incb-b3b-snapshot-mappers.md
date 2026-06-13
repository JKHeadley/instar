# WS5.2 Increment B / B3b-snapshot — balancer snapshot mappers (dark/unwired)

<!-- bump: patch -->

<!--
  NOTE: dark/unwired pure helpers. One new module (CredentialRebalancerSnapshot) + its
  unit test. Stateless mappers from SubscriptionPool accounts + CredentialLocationLedger
  assignments + config into the policy's snapshot — the providers the B3a orchestrator
  consumes. No IO, no config flag, no route, no credential write path. The server.ts
  construction + setInterval + live route that USE these mappers is the next step.
-->

## What Changed

Adds the pure translation layer between the live system state and the balancer's decision core, kept out of server.ts so a units/sign bug can't silently mis-steer the balancer.

- **`CredentialRebalancerSnapshot`** (src/core/CredentialRebalancerSnapshot.ts) — pure mappers:
  - `mapAccount`/`mapAccounts`: a SubscriptionPool account → the policy's `AccountState` (5h/weekly utilization %, weekly-reset hours, status). A missing quota reading maps to an epoch `measuredAt` so the account is treated as STALE (source-only) — never dealt in on a reading we don't have. `rate-limited` stays eligible (`ok`) so wall-avoidance can rescue its slot; only `needs-reauth`/`disabled` are ineligible.
  - `mapSlot`/`mapSlots`: a CredentialLocationLedger assignment → the policy's `SlotState` (default-slot flag, quarantine, last-verified time; a quarantined-empty slot normalizes to a null tenant).
  - `resolveRebalancerConfig`: clamp the configured knobs into the resolved config and derive the cooldowns from the poll interval (per-pair 1×, per-tenant 2×) + the stale-quota window (N poll periods).
- Unwired + dark; the server construction + the timer pass + the live status route are the next step <!-- tracked: 20905 -->.

## What to Tell Your User

Still nothing changes — off-by-default internal plumbing. This is the translator that turns your real account quota and login layout into the form the (not-yet-active) balancer's brain understands. It's careful about safety even here: if it doesn't actually have a fresh quota reading for an account, it treats that account as "don't move anything onto it" rather than guessing; and a rate-limited account stays eligible to be rescued rather than being written off. It only translates data — nothing acts.

## Summary of New Capabilities

No new runtime capability — pure translation helpers for the Increment-B balancer, shipped dark. New internal module `CredentialRebalancerSnapshot` (mapAccount/mapSlot/resolveRebalancerConfig): the unwired providers the balancer orchestrator will consume. Not wired into any runtime path; no route, no config flag, no credential write path.

## Evidence

- `tests/unit/credential-rebalancer-snapshot.test.ts` (10) — status eligibility (rate-limited stays ok; needs-reauth/disabled ineligible); quota mapping incl. weekly-reset hours + missing-reading → stale; slot mapping (default flag, quarantined-empty → null tenant, override fields); config defaults + clamping + cooldown derivation. tsc + full lint clean.
