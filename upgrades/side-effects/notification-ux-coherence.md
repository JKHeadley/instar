# Side-Effects Review — Notification UX Coherence (PR1: the calm Agent-Health lane)

## What changed (mechanically)

A new opt-in routing lane in the messaging layer. An attention item may now carry
`lane:'agent-health'` (+ optional `healthKey`). When set, `createAttentionItem`
routes it into ONE persistently-named "🩺 Agent Health" forum topic BEFORE (and
bypassing) the topic-flood guard, suppression-dedups same-`healthKey` re-escalations
within a window, and never spawns a per-item topic. `StaleSessionBackstop` now emits
its "looks stuck" escalation into that lane at `NORMAL` (was `HIGH`), with a
topic-name-resolved, next-step-bearing, reply-able message. The `/attention` route
carries `lane`/`healthKey` through and lets lane items skip the per-topic outbound
tone-gate.

## Blast radius / who is affected

- **Items WITHOUT `lane`**: byte-for-byte unchanged — same guard, same topics, same
  tone-gate. The only caller that sets the lane today is `StaleSessionBackstop`.
- **The flood guard**: untouched logic; lane items simply never reach it.
- **The tone-gate**: still runs for every non-lane item; lane items bypass it because
  they don't spawn a per-item topic and are named+CTA-bearing by construction.

## Failure modes considered

- **Telegram unavailable**: `routeToAgentHealthLane` returns null on topic-create
  failure; the item is still recorded in the attention store (never dropped). Best-
  effort send is `@silent-fallback-ok` (a transient send failure must not crash the
  attention path) — consistent with the existing flood-notice path.
- **Lane topic deleted out from under us**: the cached `agentHealthTopicId` is cleared
  on send failure so it's recreated next time (same pattern as `floodNoticeByBucket`).
- **Concurrent first-escalations**: a single in-flight creation promise
  (`agentHealthPending`) prevents a double-create race (covered by integration test).
- **Unbounded memory**: the dedup ring is hard-capped at `maxTrackedKeys` (default 256),
  oldest-evicted.
- **A genuinely-stuck session now NORMAL not HIGH**: it still surfaces (in the calm lane
  + the attention store + the dashboard); it is no longer a per-topic interrupt. The
  global "tmux control plane unreachable" item stays HIGH. PR2 will reduce the
  false-positive RATE; PR1 only changes delivery.

## What this does NOT do (explicit non-goals)

- Does NOT gate, block, drop, delay, or rewrite any message — pure delivery-shaper.
- Does NOT change the StaleSessionBackstop's detection logic (PR2).
- Does NOT touch the "went quiet" / "can't reach…routing" SentinelNotifier paths
  (tracked as fast-follow; they were the older floods).

## Reversibility

`messaging[].config.agentHealthLane.enabled:false` restores the prior per-item-topic
behavior for self-health items. No schema migration, no data migration, no on-disk
format change. Additive type fields only.

## Tests

Unit (StaleSessionBackstop: lane/healthKey/NORMAL/named-title/next-step + name
resolution), integration (real TelegramAdapter: N notices → 1 topic, HIGH→lane,
suppression-dedup + audit, non-lane unaffected), E2E (HTTP /attention: lane+healthKey
passthrough, tone-gate bypass for lane, no regression for non-lane). 95 related tests
green; tsc clean.
