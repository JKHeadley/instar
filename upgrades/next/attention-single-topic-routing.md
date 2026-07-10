# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Attention alerts no longer spawn one Telegram forum topic per item. `TelegramAdapter.createAttentionItem` now defaults to single-topic routing (`attentionRouting.mode: 'single-topic'`, a code default — existing agents flip on update with no config edit): EVERY attention item, all priorities including HIGH/URGENT, posts as one message into the durable "🔔 Attention" hub topic the server already creates at boot (state key `agent-attention-topic`, resolved live through a new injected `getAttentionHubTopicId` accessor wired in `server.ts`). Hub messages carry the priority emoji, title, category | priority, summary, a clipped description, and the source. Hub-routed items are marked `coalesced` and are deliberately NOT registered in the per-item topic maps, so resolving one item can never close the shared hub. If the hub id cannot be resolved (fresh install) or the send fails (deleted hub), the adapter finds-or-creates the hub once (create-once + in-flight-promise, mirroring the agent-health lane) — it NEVER falls back to a per-item topic, and every item is always recorded in the attention store regardless. The 2026-05-28 flood guard and the global topic-creation ceiling remain intact and load-bearing for the legacy opt-out (`messaging[].config.attentionRouting = { "mode": "per-item" }`) and for every non-attention topic creator. The agent-health lane is unchanged and still takes precedence for its items. This closes the slow-drip hole the burst-only flood guard could not see (alerts hours apart, each a new topic — ~317 junk topics by 2026-07-09) and executes the operator directive from topic 11960: "Alerts should all go into a SINGLE topic with a dedicated name that is for alerts and NOTHING else."

## What to Tell Your User

- **All alerts now land in one place**: "My alerts — every priority, including urgent ones — now go into the single '🔔 Attention' topic instead of each creating its own new topic. Your topic list stays clean; urgency is still visible from the priority emoji on each message."
- **Nothing for you to do**: "This is automatic. Every alert is still tracked in my attention list and on the dashboard. If you ever want the old one-topic-per-alert behavior back, it's a one-line setting."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Single-alerts-topic routing (all attention items → the "🔔 Attention" hub) | automatic (code default) |
| Legacy per-item alert topics | set `messaging[].config.attentionRouting` to `{ "mode": "per-item" }` |

## Evidence

- Unit (`tests/unit/attention-single-topic-routing.test.ts`): all four priorities route into the injected hub with ZERO `createForumTopic` calls; the hub message format is pinned (HTML-escaped title, `category | Priority`, 500-char description clip, source line); resolving a hub-routed item performs no `closeForumTopic`; with no injected hub id the hub is found-or-created exactly ONCE for N items; a dead injected hub self-heals to a created hub (item still delivered); an agent-health-lane item still routes to the lane, not the hub; legacy `per-item` mode still creates its own topic, registers the maps, and /done closes it; `server.ts` carries the resolver wiring at BOTH TelegramAdapter construction sites.
- Integration (`tests/integration/notification-flood-burst-invariant.test.ts`): SHIPPED DEFAULT — 1,000 attention items of every priority with unique sources create ≤ 1 topic (the hub) and all 1,000 are stored; the legacy-mode guard invariants (per-source cap + coalesce topic, guard-disabled backstop, critical-flood ceiling, mid-flood critical carve-out) all still hold under the explicit `per-item` pin; the Standard-C contract block now pins HIGH/URGENT → the SAME single hub.
- E2E (`tests/e2e/attention-topic-flood-guard-lifecycle.test.ts`): a stock production config (token + chatId ONLY — exactly what a fleet agent has after a silent dist update) routes a 40-item mixed-priority slow-drip into exactly ONE hub topic with every item stored and pointing at it; the legacy opt-out still caps a flooding source at budget + 1 coalesced notice topic.
- Slack verified unchanged: the Slack attention surface already routes to the single `slack-attention-channel`; no per-item surfaces exist there.
- Full `test:all` (unit + integration + e2e) green in the worktree before push.
