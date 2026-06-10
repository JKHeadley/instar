<!-- bump: patch -->

## What Changed

Makes the SentinelNotifier's consolidated-escalation delivery **self-heal a deleted lifeline/system topic instead of silently swallowing the error**. Both `sendConsolidated` closures in `server.ts` (the sentinel-notify path and the stop-notify path) did `try { telegram.sendToTopic(lifelineTopicId, text) } catch { return false }`. When the lifeline/system topic is deleted on the Telegram side, every send returns `400: message thread not found`, and the bare `catch` black-holed it — so stall/stop escalations the system generated never reached the user, with zero log trace. New shared helper `sendConsolidatedWithSelfHeal` (`src/monitoring/sentinelConsolidatedSend.ts`): sends to the lifeline topic; on failure it (1) logs the real error (de-swallow) and (2) calls the adapter's existing `ensureLifelineTopic()` — which recreates a deleted topic and persists the new id — then retries the send once. Both call sites now use it. No behavior change on the happy path (a working topic sends and returns immediately, never touching `ensureLifelineTopic`).

## What to Tell Your User

If your "Lifeline"/system topic ever gets deleted, the alerts the system tries to send you there (a session went quiet, a session stopped) used to vanish without a trace — you'd just get silence. Now those alerts heal themselves: the system recreates the topic and delivers the alert, and any delivery failure is logged instead of disappearing. (This is the foundation under the broader "tell me when a session stalls, in that session's own topic, and auto-recover it" work.)

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Sentinel/stop escalations self-heal a deleted lifeline topic + never swallow the send error | automatic — no config |

## Evidence

Reproduction (live, 2026-06-09): the configured lifeline topic (`lifelineTopicId: 2`, "Lifeline") had been deleted on Telegram. `logs/sentinel-events.jsonl` showed the active-silence sentinel correctly detecting stalled sessions and emitting `escalated` ("session went quiet ~16 min ago, want me to dig in?") — immediately followed by `notify-error: sendConsolidated returned false`, **41 times in one day**. A direct probe (`POST /telegram/reply/2`) returned exactly `400: Bad Request: message thread not found`, confirming the dead topic. The user received pure silence, so a stalled session was indistinguishable from a working one.

After the fix: `tests/unit/sentinel-consolidated-send.test.ts` (7 cases) pins the happy path (no ensureLifelineTopic call), the dead-topic self-heal (recreate id 2→new, retry, deliver), the no-topic-configured path, and all three failure modes (ensure returns null / ensure throws / retry fails) — each returning false WITH a logged reason, never a silent swallow. tsc + repo lint clean. (The 15 unrelated A2ARedeliverySentinel / SessionActivitySentinel local failures are pre-existing on main, not introduced here.)
