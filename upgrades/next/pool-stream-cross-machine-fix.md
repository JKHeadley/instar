# Upgrade Guide — Pool Dashboard Streaming: remote scrollback + post-hiccup recovery

<!-- bump: patch -->

## What Changed

Fixes the two live bugs from 2026-06-08 testing that left cross-machine dashboard streaming connecting-but-blank with no recovery (POOL-DASHBOARD-STREAM-SPEC, shipped #950–#970):

- **Closed-proxy eviction** (`WebSocketManager.peerProxyFor`): a peer's stream proxy that reached `closed` — after the bounded reconnect failed, or after the 60s idle grace once the last viewer left — stayed cached forever, and a closed proxy silently ignores every later subscribe while the server still answered `subscribed`. One hiccup (or one minute of nobody watching) made that machine permanently unstreamable until a server restart. The get-or-create chokepoint now evicts a closed proxy and opens a fresh episode with its own bounded reconnect budget (P19 no-storm guarantee preserved: reconnects remain one-per-episode, new episodes only on explicit user subscribes).
- **Cross-machine scrollback** (`history` relay): the terminal-history fetch only ever captured locally — structurally empty for a session owned by another machine. It now relays upstream for remote-subscribed sessions exactly like input/key (spec §2.2: capture happens ONLY on the owning machine), via a new read-only `PeerStreamProxy.relayFrame`; the dashboard client sends `machineId` on history requests for remote tiles.
- **Honest history miss**: the "no output for session" reply was a sessionless error frame, which the peer fan-out structurally drops; it now carries `session` + `code:'session-not-found'` and renders in the terminal (§2.4 failure honesty).

The serving side of the protocol is unchanged — an updated machine streaming from a not-yet-updated peer degrades to exactly today's behavior at worst. The remote-input default-off security gate is untouched.

## What to Tell Your User

- "Watching one machine's terminal from another machine's dashboard now actually shows the terminal — including scrolling back through its history — and if the link between machines hiccups, clicking the session again recovers it instead of staying dead until a restart."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Remote session scrollback | Automatic — scroll up in any remote session's terminal in the dashboard |
| Stream recovery after a dropped peer link | Automatic — re-clicking the session tile opens a fresh, bounded connection episode |

## Evidence

- 7 new unit tests (5 behavior + 2 regression guards) across `tests/unit/WebSocketManager.test.ts` and `tests/unit/PeerStreamProxy.test.ts`; each behavior test was run against the UNFIXED code first and failed for the stated reason (missing relayFrame, ignored re-subscribe after closed, sessionless error), then green with the fix.
- Full unit suite green in the worktree; `pnpm build` clean.
- Live verification on the real laptop + Mac Mini (a Mini session terminal rendering on the laptop dashboard, then recovery after an induced link drop) — performed post-deploy, results recorded in topic 13481.
