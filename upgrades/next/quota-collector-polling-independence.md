# Quota collector now runs even when the lifeline owns Telegram polling

## What Changed

The quota collector (which writes quota-state.json) and the QuotaManager that
drives its adaptive polling were nested inside the server's
"I own Telegram polling" block. On any agent whose LIFELINE owns polling — the
normal production topology — that block is skipped, so the collector never ran:
quota-state.json was never written, the tracker read an absent file, and
quota-aware placement stayed permanently fail-open (the exact rate-limit-stall
hazard from the EXO incident it exists to prevent). Turning on quotaTracking
alone could not fix it; the writer was gated behind an unrelated condition.

The account switcher + collector + QuotaManager pipeline now live at top scope
(after the scheduler is constructed, so migration wiring is real), gated only on
the quota tracker — so the collector runs regardless of who polls Telegram.

## What to Tell Your User

If you run a lifeline-driven agent and turned on quota tracking but never saw
quota data, this is why — now it collects. Quota-aware placement (routing work
away from a rate-limited machine) actually has data to act on.

- audience: agent-only
- maturity: stable

## Summary of New Capabilities

- Quota collection + adaptive polling run independent of Telegram-polling
  ownership (was send-only-server dead).
- accountSwitcher hoisted to top scope (still consumed by the polling block's
  wireTelegramCallbacks when that path runs).

## Evidence

- `tests/unit/quota-collector-polling-independence-wiring.test.ts` (new, 3
  tests): quotaManager.start() is reached before the !lifelineOwnsPolling
  block; the pipeline is constructed after the scheduler; no second
  QuotaManager construction (no double-start).
- Live: echo logs "Telegram send-only mode (lifeline owns polling)" + "No quota
  state file found — fail-open" pre-fix; quota-state.json + real GET /quota data
  post-fix (live re-verify after release).
