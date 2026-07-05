---
user_announcement:
  - audience: agent-only
    maturity: stable
---

## What Changed

Fixed the final live-proven S7 gap: a Slack session that gets **respawned** (via `/sessions/refresh`,
a quota-swap, a restart, or restart-all — all funnel through `SessionRefresh` → `slackRespawner`) now
re-mints its conversation bind token. A **fresh** Slack spawn passes `bootstrapConversationIds` so the
session gets `INSTAR_BIND_TOKEN` + `INSTAR_CONVERSATION_ID` and can open durable state (a commitment)
bound to its minted conversation id; the respawn path **omitted** it, so a refreshed/quota-swapped Slack
session came up token-less, its durable binds were refused (fail-closed), and the follow-through fell
back to a fragile session-local timer that dies on the next restart. The respawn now resolves the
conversation id from the routing key (idempotent get-or-create) and passes it, restoring parity with the
fresh spawn. Telegram was unaffected (it has a `telegramTopicId` fallback; Slack had none).

## What to Tell Your User

Nothing proactive — this is an internal robustness fix. If a user ever asks why a Slack promise didn't
survive a session swap or restart, the answer is that a restarted Slack session used to lose the small
security key it needs to save a durable, restart-proof promise, so it fell back to a flimsy timer; now
a restarted Slack session keeps that key, so the durable follow-through survives restarts.

## Summary of New Capabilities

- A refreshed / quota-swapped / restarted Slack session now registers durable, restart-surviving
  follow-through (a commitment bound to the Slack conversation), matching a fresh spawn.
- Fail-open: if the conversation-id lookup errors, the respawn proceeds (prior token-less behavior),
  never blocked.
- No config, no persistent state, no Telegram change.

## Evidence

- `tests/unit/slack-respawn-bootstrap-ids.test.ts` — 4 cases (id → `[id]`, full `channel:thread` key,
  `null` → `undefined`, throwing registry → `undefined` / no rethrow).
- Existing `tests/unit/sessionRefresh-slack.test.ts` (22) stay green; `tsc` clean.
- Live proof it closes: `docs/investigations/s7-slack-delivery-repro-2026-07-04.md` §9 — Round-1
  (already-running session) durable bind refused; Round-2 (fresh session) durable `CMT-1922` bound to
  the minted id. This fix makes the respawn path behave like Round-2.
