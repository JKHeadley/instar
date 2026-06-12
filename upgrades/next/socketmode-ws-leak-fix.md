# Upgrade Guide — Slack Socket Mode: no more leaked websockets after sleep/wake

<!-- bump: patch -->

## What Changed

`SocketModeClient` leaked one live websocket on every deliberate `reconnect()` (JKHeadley/instar#1076). The old "temporarily clear `started`" save/restore was synchronous, but websocket close events fire on a later tick — by the time the old socket's close handler ran, the flag was restored and `this.ws` pointed at the freshly-opened replacement. The stale handler nulled `this.ws` (orphaning the replacement: still OPEN, untracked, counting against Slack's ~10-connection Socket Mode cap) and fired another reconnect. The SleepWake handler calls `reconnect()` on every wake, so after ~10 wakes the cap blew and the client churned with `too_many_websockets` permanently (observed live 2026-06-12: 5,075 disconnects in 73 minutes, plus sustained `apps.connections.open` rate-limiting; only a server restart cleared it). A second race let a sleeping backoff retry open a connection on top of one an explicit `reconnect()` had just opened.

The fix is structural, confined to `src/messaging/slack/SocketModeClient.ts`: (1) every socket's event handlers are closure-bound to that socket and ignore events when it is no longer the tracked connection (`this.ws !== sock`); (2) a connection epoch is bumped on every deliberate teardown, and every in-flight async path (awaited `apps.connections.open`, sleeping backoff, delayed `too_many_websockets` retry) captures the epoch at start and stands down if superseded. Invariant: at most one tracked, live connection regardless of how reconnect triggers interleave. The wake-detector trigger-happiness that amplified this (453 wake events/day on ~10s gaps) is tracked separately in JKHeadley/instar#1077.

## What to Tell Your User

- "Fixed a bug where laptop sleep/wake cycles slowly leaked Slack connections until Slack started kicking the agent off ('too many websockets') — Slack now stays cleanly connected through any number of sleep/wake cycles, no restart ritual needed."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Leak-free Slack reconnects across sleep/wake | Automatic |

## Evidence

- New behavioral test file `tests/unit/slack-socket-leak.test.ts` (fake-websocket harness, 5 tests) proven failing on the unfixed client first (3/5 fail — the stale-backoff race opened FOUR connections), all pass on the fix; includes regression guards for natural-close reconnect and deliberate disconnect.
- Updated source-assert tests in `slack-socket-reconnect.test.ts` / `slack-socket-heartbeat.test.ts` now pin the epoch + identity-guard pattern instead of the broken save/restore pattern.
- Live incident evidence in JKHeadley/instar#1076 (log counts, onset timeline, post-restart stability).
- Side-effects artifact: `upgrades/side-effects/socketmode-ws-leak-fix.md`.
