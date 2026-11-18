# Telegram replies are no longer held while the server is busy

<!-- bump: patch -->

## What Changed

The Telegram origin layer refreshes its settings snapshot every 5 seconds and holds outbound replies once the last good snapshot is older than 30 seconds. Each refresh had a 10 second budget. Under a busy event loop (back-to-back 2-5 second tasks on the Studio, 2026-11-17/18) a refresh, which takes about six event-loop hops, routinely ran past 10 seconds and was discarded. Two in a row aged the snapshot past 30 seconds and replies were held ("config snapshot unavailable: origin-config-reader-timeout", 32 times in one evening). The read budget is now 25 seconds, and the two small state files read on each refresh (`agent-attention-topic.json`, `topic-profiles.json`) are read synchronously instead of in four async hops each. The 30 second freshness bound is unchanged and still counts from before the bytes were read; real refusals still revoke at once.

## What to Tell Your User

- **Replies not held when the agent is busy**: "When I'm doing heavy background work, my Telegram replies to you no longer get stuck waiting. Settings checks now get enough time to finish on a busy machine."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Telegram replies keep flowing while the server is busy | Automatic |

## Evidence

Live Studio log 2026-11-18 00:46-01:12Z: 32 `origin-config-reader-timeout` lines, flapping every 20-60 s, with no single event-loop freeze over 8 s logged in that window. Measured outside the server under the same load (34): the read's parts take about 60 ms in total (keychain call 40 ms, worker start 13 ms, merge 50 ms), so the time is spent waiting between hops, not working. Tests: `tests/unit/telegram-origin/config-reader.test.ts` (budget is 25 s; timed-out reads keep the revision; real refusals revoke) and `tests/unit/telegram-origin/notice-policy-observer.test.ts`: 15 passed.
