# Side-Effects Review — Quota collector polling independence (finding A1)

**Version / slug:** `quota-collector-polling-independence`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

The QuotaManager/collector/accountSwitcher pipeline was hoisted out of the
`if (telegramConfig && !skipTelegram && !isStandbyTelegram && !lifelineOwnsPolling)`
block to top scope (after the scheduler exists), gated only on quotaTracker.
On lifeline-owns-polling agents the collector never started → fail-open
placement (finding A1).

## Decision-point inventory

One: WHERE the pipeline runs. Now: top scope, after scheduler, gated on
quotaTracker. Before: inside the server-owns-polling block.

## 1. Over-block

None. The pipeline now runs in MORE cases (send-only servers too), never fewer.

## 2. Under-block

The collector still no-ops for non-claude-code frameworks (unchanged) and when
quotaTracking is off (unchanged). A missing OAuth credential still degrades to
JSONL estimation inside QuotaCollector (unchanged).

## 3. Level-of-abstraction fit

Quota collection is independent of Telegram-polling ownership; placing it with
the other top-scope monitoring setup (after scheduler, beside telemetry
heartbeat) is the correct layer. accountSwitcher moves with it; its later
consumer (wireTelegramCallbacks, inside the polling block) resolves it from the
enclosing scope — verified by tsc.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority change. quota-aware placement remains fail-open on absent data;
this fix simply lets the data exist.

## 5. Interactions

- Scheduler: the pipeline now runs after `scheduler` is constructed, so
  setScheduler() wires a real scheduler (was already conditional on `scheduler`).
- wireTelegramCallbacks (polling block): consumes the hoisted accountSwitcher
  from the enclosing scope — only runs in the polling path, harmless otherwise.
- notify(): defined at outer scope (function decl), called lazily on threshold
  crossings — safe to construct the notifier earlier.
- Double-start: the old in-block copy was REMOVED (test asserts a single
  QuotaManager construction) — no risk of two pollers.
- guard-posture tripwire: already observed quotaTracking re-enabled; this fix
  makes that enablement actually produce data.

## 6. External surfaces

No new routes/config/notifications. `GET /quota` now returns real data on
lifeline-driven agents instead of `no_data`.
