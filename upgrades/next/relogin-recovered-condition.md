# Upgrade Guide — vNEXT

## What Changed

- `src/core/SubscriptionReloginService.ts`: a terminal FAILED or REFUSED repair whose account×machine cell is verified signed in again (`cellHealthy`) and has no other repair still running no longer sends its "repair ended in failed" notice; the service reports the condition over through a new `onConditionCleared` dep, both from the notice drain and from every tick (`reportRecoveredConditions`, newest episode per cell, once per episode per process).
- `src/core/SubscriptionReloginRuntime.ts`: the verified-health check is now `cellVerifiedHealthy(accountId, machineId)` (this machine only; pool `active`, no identity drift, live `loginCheck` `ok`) and is exposed on the runtime; `onConditionCleared` is plumbed to the service.
- `src/core/SubscriptionReloginAttention.ts`: `clearRecoveredReloginAttention` closes the condition-keyed row and any legacy id-prefixed row for that episode via `clearAttentionCondition`.
- `src/commands/server.ts`: wires `onConditionCleared`; the hourly-pass resolver's local health check uses `cellVerifiedHealthy` instead of `status === 'active'`.
- CLAUDE.md template + `migrateClaudeMd`: one sentence appended to the slow-retry bullet (content-sniffed on "why did that sign-in alert disappear?", idempotent).

## What to Tell Your User

When an automatic sign-in repair failed, I used to tell you about it even if the account came back on its own a few minutes later, and the alert then sat on your Attention list until someone closed it. Now, if the account is confirmed signed in again before I send the alert, I don't send it, and if the alert already went out, it closes itself once I've confirmed the account is working, with a short note saying so. If the account is still signed out, or I can't confirm it, you still hear about it exactly as before.

## Summary of New Capabilities

- A failed or refused sign-in repair whose account is verified signed in again sends no failure notice.
- Its Attention row closes itself on the next repair-service tick with the resolution "signed in again (verified on this machine)".
- The hourly attention pass closes sign-in rows only on verified health (active + matching identity + live login check), not on the pool label alone.

## Evidence

- Unit: `tests/unit/subscription-relogin-recovered-condition.test.ts` (10: still signed out → notice delivered and condition kept; verified → no notice, condition reported once, episode stays failed; delivered-then-recovered closes; refused; a live sibling repair keeps it; a failing clear retries; a notice delivered after an earlier recovery report is closed again; the clear helper; the resolver both sides), `tests/unit/PostUpdateMigrator-assistedRelogin.test.ts` (+3 assertions).
- Integration: `tests/integration/subscription-relogin-recovered-attention.test.ts` (4, real routes + real adapter + real store/service).
- E2E: `tests/e2e/subscription-relogin-recovered-attention-alive.test.ts` (the real `createSubscriptionReloginRuntime` composition; a label-only `active` does not close the row, a verified sign-in does).
- Incident: Mac Mini episode 07a2d827 events 65/66/68 (2026-10-26 20:21:58Z failed, 20:22:28 retry scheduled, 20:28:28 unscheduled on recovery; alert raised 21:21:58Z).
