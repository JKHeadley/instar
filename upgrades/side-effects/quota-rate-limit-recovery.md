# Side-Effects Review — Rate-limited subscription recovery

**Version / slug:** `quota-rate-limit-recovery`
**Date:** 2026-11-07
**Author:** Echo
**Second-pass reviewer:** not required

## Summary of the change

Tier 1 narrow reversible fix in `QuotaPoller.ts`, with related unit tests, ELI16 and release fragment. The status decision is limited to an account already marked `rate-limited`. A fresh authenticated snapshot with both quota windows below 100%, and no pending reset for a previously exhausted window, moves it to `active`. The usage mapper also refuses to infer 0% utilization from a reset timestamp alone.

## Decision-point inventory

- `QuotaPoller.pollOne` — modified: recovery after a successful read.
- `SubscriptionPool` eligibility — pass-through: still accepts active accounts only.

## 1. Over-block

A healthy Codex account reporting only a weekly window remains held. That is intentional because the absent short window cannot rule out a five-hour limit. A prior exhausted window with no valid reset timestamp also remains held.

## 2. Under-block

An account marked rate-limited externally with no prior saturated snapshot can recover from a fresh authenticated below-limit reading. If the external marker represented a different, unreported limit, this could resume placement too early. The poller has no provenance for that marker; the PR calls out the unknown writer.

## 3. Level-of-abstraction fit

The quota poller owns fresh provider measurements and already restores another account status after a clean read. SubscriptionPool keeps the placement rule. No new parallel placement decision is added.

## 4. Signal vs authority compliance

The fresh usage snapshot is an authenticated provider signal. The deterministic status policy uses explicit window values and prior reset timestamps. It does not add a brittle message filter or a separate blocker.

## 5. Interactions

The existing needs-reauth restoration remains separate. Disabled accounts are not polled; warming is never changed. The device-limit tripwire continues to own its needs-reauth hold. There is no background timer or second status writer.

## 6. External surfaces

An eligible account may re-enter pool placement on the next successful poll. Quota fetch failures and rollout-only observations cause no recovery. The timing of recovery follows the normal poll cadence.

## 7. Multi-machine posture

Machine-local by design: each pool and quota poller reads the credentials and usage of the account installed on that machine. No replicated status change or user-facing notice is added.

## 8. Rollback cost

Revert this PR to stop automatic recovery. Accounts already restored can be marked rate-limited again through the normal account update route if needed; no data migration is involved.

## Proportion

Tier 1, four source/test/artifact files plus one release fragment; no spec review rounds. One planned commit/gate attempt. Related unit test file only; the normal queue runs the full suite.
