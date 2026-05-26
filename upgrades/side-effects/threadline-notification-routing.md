# Side-Effects Review — Threadline notification routing (CMT-519)

**Version / slug:** `threadline-notification-routing`
**Date:** 2026-05-25
**Author:** Echo
**Second-pass reviewer:** (pending — required; touches messaging routing + a structural redirect "guard")

## Summary of the change

Threadline notifications no longer spawn a Telegram topic per event. `CollaborationSurfacer` gains a `notify()` entry (status/housekeeping → the single SILENT "Threadline" hub, never the parent topic), record-shaped surface state (with a legacy `string[]` read-migration) + bind helpers (`mostRecentUnbound`, `markBound`, `noteInHub`). The loop-gate (`src/commands/server.ts` ~7167) routes through `notify()` instead of `createAttentionItem`. `POST /attention` redirects threadline-class items to the hub. A new `POST /threadline/hub/bind` promotes ("open this") / binds ("tie this to X") a surfaced conversation to a topic — authoritatively setting `boundTopicId` + the commitment's `topicId`. Template + migration teach agents the hub + "open this" behavior. Decision points: the `/attention` reroute (routing, not block/allow), the loop-gate notice destination, the bind mutation.

## Decision-point inventory

- `POST /attention` threadline-class redirect — **add** — reroutes threadline/inter-agent/spawn items to the silent hub instead of a per-event topic.
- Loop-gate wind-down destination (`server.ts`) — **modify** — `createAttentionItem` → `collaborationSurfacer.notify()` (hub, not parent, not per-event topic).
- `POST /threadline/hub/bind` — **add** — authoritative thread→topic bind.
- CollaborationSurfacer status vs first-contact surfacing — **modify** — adds the status lane (`notify`) alongside the existing parentless first-contact lane (`surface`).

## 1. Over-block
No block/allow surface — these are routing/delivery decisions, not gates. The `/attention` redirect could mis-route a *legitimate general* item if its title coincidentally matches `threadline|inter-agent|spawn|relay` — mitigated by the category-first check (`/^(threadline|inter-agent|relay|spawn)/i` on category) plus content sniff only on distinctive phrases (`spawn-storm`, `spawn to receive`, `cannot spawn`, `inter-agent`, `\bthreadline\b`). A generic "spawn a new worker" general item would NOT match (no category prefix, no distinctive phrase). Worst case the item lands in the hub instead of its own topic — recoverable, not lost.

## 2. Under-block
A threadline alert posted via `/attention` with a *non-threadline category AND no distinctive phrase* would still get its own topic. Acceptable: the in-code threadline emitters (loop-gate) now route correctly; the redirect is a backstop for ad-hoc posts. The `TelegramBridge.mirrorInbound` per-thread topic path is intentionally excluded as a deliberate opt-in feature (default-off — the operator turned it on knowingly), not a notification the routing fix should override.

## 3. Level-of-abstraction fit
Correct: extended `CollaborationSurfacer` (already the hub owner) rather than a parallel router (convergence Q1). Status notices use a delivery sink (`notify`); real reply *content* still flows via the existing `TopicLinkageHandler` parent-topic path (one emitter per topic — avoids the double-notify the reviewer flagged, H2). The bind endpoint composes existing primitives (`ConversationStore.mutate`, `findOrCreateForumTopic`, `commitmentTracker.mutate`).

## 4. Signal vs authority compliance
No new blocking authority. The `/attention` redirect is a router (reroute + 201, never a hard block). `notify()`/`surface()` are delivery sinks. The bind endpoint mutates state on explicit operator action. Per `docs/signal-vs-authority.md`: detectors/sinks, not gates.

## 5. Interactions
- **No double-surface:** status (`notify`) → hub only; content (replies) → parent topic via TopicLinkageHandler only. The loop-gate path `return`s after notify, so it never also hits surface(). `surface()` (parentless first-contact) and `notify()` (status) are distinct lanes; a single inbound triggers at most one.
- **Bind vs first-write-wins:** `hub/bind` is authoritative — it overrides `captureOriginOnSend`'s anti-poisoning refusal by directly setting `boundTopicId` + the commitment `topicId` (operator intent > heuristic).
- **Legacy state migration** is read-time + idempotent; new record-shape round-trips.

## 6. External surfaces
New `transport`-free; new route `POST /threadline/hub/bind` (503 when telegram/conversationStore absent). Hub stays silent (`{silent:true}`) — no new buzzing. Template/migration change is agent-facing (Agent Awareness Standard) + idempotent (Migration Parity).

## 7. Rollback cost
Localized: CollaborationSurfacer (additive methods + schema with back-compat read), one server.ts callsite, two routes.ts additions, template + migration. Clean `git revert`. The surface-state schema change is forward+backward tolerant (load() reads both shapes); no data migration needed. New agents get the template via `generateClaudeMd`; existing via `migrateClaudeMd` (idempotent).

## Second-pass review

**Concur with the review** (independent reviewer, 2026-05-25). Verified all six checks against the diff: (1) the loop-gate `budgetExhausted && collaborationSurfacer` guard is sound (surfacer is `telegram ? new ... : undefined`), and the dropped `createAttentionItem` had no `/ack` consumer — nothing operational lost; (2) `load()` migration round-trips all three shapes (records / legacy string[] / dedicatedTopicId-only) with no loss of `dedicatedTopicId`; (3) the `/attention` redirect runs after `checkOutboundMessage`, matches only category-prefix `^(threadline|inter-agent|relay|spawn)` OR distinctive body tokens (8 realistic inputs tested — "CI failed", "relay race", "Spawning a new initiative" correctly do NOT match), else falls through; (4) `hub/bind` 503/404/409/200 paths correct, authoritative bind sets `boundTopicId` + commitment `topicId` via existing CAS-safe mutates, null-safe field access, all awaits correct, tsc clean; (5) migration content-sniff marker exactly matches the template heading — idempotent; (6) no double-surface — the `budgetExhausted` path `notify()`s then `return`s before `surface()`, and `surface()` early-returns on `hasParentTopic`; mutually exclusive per inbound.

Reviewer's one non-blocking gap — the new HTTP routes lacked Tier 2/3 coverage — has been **addressed**: added `tests/integration/threadline/hub-bind-routes.test.ts` (6 tests: 503/400/404/409/200-open/200-tie, asserting `boundTopicId` is set through the real `createRoutes` pipeline). The `/attention` redirect's match logic is covered by the reviewer's verified 8-input analysis + live test-as-self.
