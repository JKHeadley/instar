# Side-Effects Review — attention lifecycle pass runs on send-only servers

**Version / slug:** `attention-lifecycle-send-only`
**Date:** `2026-10-26`
**Author:** `Echo`
**Second-pass reviewer:** `not required (no gate, session lifecycle or messaging decision changes)`

## Summary of the change

PR #2361 added an hourly attention lifecycle pass (merge duplicate rows, close rows whose cause cleared, expire untouched rows). Its timers were armed only in `TelegramAdapter.start()`, the long-polling path. A server whose lifeline holds the Telegram poll lease, and a standby machine, boots in send-only mode and never calls `start()`. Every server on Echo's machines boots that way, so no automatic pass ever ran: `GET /attention/lifecycle` still showed the 17:46Z manual sweep hours later.

Fix: a public, idempotent `TelegramAdapter.startSendOnlyMaintenance()` arms the same boot (2 min) and hourly timers, and `server.ts` calls it in the send-only branch right after constructing the adapter. `start()` already returns early when the timers exist, so a send-only adapter that later polls never gets a second timer, and `stop()` clears them as before. A read-only `attentionLifecycleTimersRunning` getter exposes the state for tests.

Tier 1: three added lines of wiring plus a small method; a revert fully undoes it. Size: 2 source files, ~25 lines, plus 3 test files. Effort: one build pass, no spec rounds.

## Decision-point inventory

None added. The pass that now runs on send-only servers is the existing PR #2361 pass with its existing rules (first pass per machine lists expiry as a dry run; acknowledged, in-progress, security and active-condition rows are never expired).

## 1. Over-block

Nothing is blocked. The change makes an existing closing pass actually run. Rows the pass closes are rows PR #2361 already decided should close; the rollback switch `messaging[].config.attentionLifecycle.enabled: false` still stops it.

## 2. Under-block

A server built with Telegram disabled entirely has no adapter and so no attention store to reconcile; nothing to miss there. Slack-only agents have no attention store in this adapter either.

## 3. Level-of-abstraction fit

The timers belong to the adapter that owns the attention store, which is where they already lived. The only missing piece was a start call on the send-only path; the server's send-only branch is the one place that knows that mode.

## 4. Signal vs authority compliance

No new authority. The pass's authority (closing rows) was approved with PR #2361; this change only stops it being silently inert. See `docs/signal-vs-authority.md`.

## 5. Interactions

- `start()` and `startSendOnlyMaintenance()` share one guard (`if (this.attentionLifecycleTimer) return`), so no double pass. Tested.
- The lifeline polls with its own client, not a `TelegramAdapter`, so only the server process writes the attention store; no second writer is introduced.
- Manual `POST /attention/lifecycle/sweep` keeps working and shares the same state file.

## 6. External surfaces

Operators will now see the hourly pass close duplicate and stale attention rows on send-only servers, as the CLAUDE.md template already promises. No route, config or message format changes.

## 7. Multi-machine posture

Machine-local by design, as in PR #2361: each machine keeps its own attention store and now runs its own pass (standby machines are send-only, so they were the other group that never ran it). The pool view still merges per-machine rows on read.

## 8. Rollback cost

Revert the commit, or set `messaging[].config.attentionLifecycle.enabled: false` without a release. No state migration.

## Conclusion

Closes the gap between the documented hourly pass and what send-only servers did. Ship.

## Evidence pointers

- `tests/unit/attention-lifecycle-send-only.test.ts`: no pass without the call; boot pass at 2 min and hourly after, never polling; idempotent with a later `start()`; `stop()` clears.
- `tests/integration/attention-lifecycle-send-only.test.ts`: `GET /attention/lifecycle` shows `lastSweepAt` advancing at 18:02 and 19:00 with no manual sweep.
- `tests/e2e/attention-lifecycle-send-only-alive.test.ts`: `server.ts` send-only branch calls `startSendOnlyMaintenance()` and never `start()`; production-default adapter records both passes over the real routes.
