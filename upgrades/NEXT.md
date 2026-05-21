# Upgrade Guide — v1.2.1 (Secret Drop hardening — non-destructive retrieve + stuck-consumer event)

<!-- bump: patch -->

## What Changed

The `/secrets/retrieve/<token>` endpoint is now **non-destructive by
default**. Repeated calls return the same value until the in-memory
5-minute cleanup timer fires. Callers that need one-shot semantics opt
in by appending `?consume=true` to the URL.

Three concrete surface changes in `src/server/SecretDrop.ts` and
`src/server/routes.ts`:

1. **Two new methods on `SecretDrop`.** `peekReceived(token)` returns
   the submission without removing it; `consumeReceived(token)` returns
   AND removes it. The existing `getReceived(token)` is preserved as a
   back-compat alias for `consumeReceived(token)` so no caller breaks.

2. **The retrieve route honors `?consume=true`.** Default behavior is
   `peek`. The response includes a `consumed: boolean` field so callers
   can self-check which path ran.

3. **Stuck-consumer event.** If a submission lingers in the in-memory
   store for >60 seconds without being explicitly consumed, every
   registered listener is invoked with a `StuckConsumerEvent`. The
   default route-layer listener routes a `[secret-drop-stuck]` system
   message to the bound topic's agent session, giving the operator a
   visible cue that the consumer chain broke.

## Evidence

Reproduction prior: on 2026-05-20 in topic 10873, a bridge script
called `/secrets/retrieve/<token>`, the server returned the submitted
SMS code AND deleted it atomically, and the bridge's parser dropped
the value on the way to disk. The code was lost; Telegram had to send
a fresh one. Pattern verified end-to-end in
`tests/unit/secret-drop-hardening.test.ts` ("regression: 2026-05-20
lost-SMS-code scenario"): the test reproduces the buggy-consumer drop
and asserts that under the hardening a retry succeeds because the
submission is still in the store.

Reproduction after: same buggy-consumer flow. First call returns the
value AND it stays in the store. The buggy parser fails. Second call
returns the value again. Caller fixes the parse and explicitly
consumes. No code is lost.

Idempotency, grace-period, and listener-isolation contracts verified
by 13 unit cases. The pre-existing `tests/unit/SecretDrop.test.ts`
suite (25 cases) continues to pass — no back-compat regressions.

## What to Tell Your User

- "I made my own secret-handling more forgiving. The bug that lost your one-time code earlier today can't repeat without a deliberate opt-in — my pickup process can now retry a failed handoff inside the 5-minute window instead of losing the value on the first attempt. And if something does sit unread for more than a minute, I now get a visible alert telling me to look at it, rather than silently waiting on a value that's already gone."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Non-destructive retrieve (default) | Agent calls `POST /secrets/retrieve/<token>`. Same call repeated within ~5 min returns the same value. |
| Explicit consume path | Agent appends `?consume=true` to commit a one-shot read. Response includes `consumed: true`. |
| Stuck-consumer event | Automatic. If a submission isn't consumed within 60s, a `[secret-drop-stuck]` system message routes to the bound topic's agent session. |

## Deferred (Tracked Follow-ups)

- Configurable grace period per-request (currently a hard-coded 60s
  constant). Will be added when a real need surfaces.
- Updating the bridge script in the parallel
  `scripts/telegram-history-backfill.mjs` PR to read non-destructively
  by default, parse first, and only consume after a successful parse.
  That refactor lives in a separate commit after this PR lands.
