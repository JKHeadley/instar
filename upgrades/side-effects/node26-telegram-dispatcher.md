# Side-Effects Review — Telegram egress falls back when Node's fetch refuses the undici dispatcher

**Version / slug:** `node26-telegram-dispatcher`
**Date:** `2026-11-09`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`src/messaging/telegram-egress.ts`: the network step of `telegramFetch` now calls `fetchWithTelegramDispatcher`. It passes the package-undici `Agent` as `dispatcher` as before; if Node's built-in fetch rejects it with `TypeError` whose cause code is `UND_ERR_INVALID_ARG` (Node 26 with undici 6.x: "invalid onError method", thrown inside `Agent.dispatch` before a socket exists), it resends the same request once without the dispatcher, sets a process-local flag so later calls skip it, and logs one warning. A `ReadableStream` body is never resent. Two test hooks are exported (`telegramDispatcherWasRejected`, `resetTelegramDispatcherRejection`).

Tier 1: one source file (+36/-1), one new test file (4 tests). Effort: no spec rounds; first commit attempt. Found blocking the Cloudflare recipe live proof (topic 135786): a new agent on the Mac Mini (system Node 26.10.0) could not create any Telegram topic.

## Decision-point inventory

No gate, filter or authority is added or changed. The change is a transport fallback below every decision point (origin admission, invisible-payload refusal, reader-visible checks all run before `network()` and are untouched).

## 1. Over-block

No issue identified. Nothing is rejected that was accepted before; a call that used to fail now succeeds.

## 2. Under-block

- If a future Node rejects the dispatcher with a different code, it still fails as today. The match is deliberately narrow, because a broader match could resend a request that reached Telegram.
- A stream-bodied request on Node 26 still fails. No Bot API caller in src/ sends a stream body today (they send JSON strings or FormData), so this is the honest boundary, not a known caller.
- Other places that pass a package-undici dispatcher to global fetch would have the same defect; `grep "dispatcher:" src` shows this file is the only one.

## 3. Level-of-abstraction fit

Right layer: the defect is in how this file pairs a dispatcher with fetch, and every Bot API call passes through this one door. Fixing the Node version selection in `instar init` (which picked /usr/local/bin/node, Node 26) would hide the defect on one machine but leave any Node-26-only host broken.

## 4. Signal vs authority compliance

Not a decision point; no blocking authority. Compliant.

## 4b. Judgment-point check

No competing-signals decision point; a deterministic transport compatibility fallback on one exact error code.

## 5. Interactions

- The catch below (`provedUnsentCode`, `OriginTransportUnsent`) still sees every non-matching error unchanged. A matching error that also fails the second attempt surfaces the second attempt's error to that classifier, which is correct: the first attempt provably never opened a connection.
- Abort signals and `networkTimeoutMs` are part of `init` and carry over to the resend; a request aborted before the resend fails as before.
- Origin-managed sends: the origin record was written before `network()`; one network invocation at most reaches Telegram, so no duplicate send.

## 6. External surfaces

On Node 26 only: Bot API requests now leave the machine (previously none did) using Node's default connect timing. One `console.warn` line per process. No API, config, or message text changes.

## 6b. Operator-surface quality

Not applicable: no operator surface touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: the flag is per process and reflects that process's own Node runtime; each machine discovers its own compatibility. No replicated state, no status surface changed.

## 8. Rollback cost

Revert the commit; the next release restores the previous behaviour (on Node 26, Telegram failing again). No state or migration.

## Conclusion

Narrow, reversible transport fix that restores Telegram on Node 26 without changing behaviour on Node 24 or any gate. Ship.
