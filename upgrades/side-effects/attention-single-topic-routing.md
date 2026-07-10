# Side-Effects Review — Single-alerts-topic attention routing (kill per-item alert topics)

**Version / slug:** `attention-single-topic-routing`
**Date:** `2026-07-10`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

`TelegramAdapter.createAttentionItem` gains a routing mode, `attentionRouting.mode`, with the code DEFAULT `'single-topic'`: every attention item — all priorities, HIGH/URGENT included — is posted as one message into the durable "🔔 Attention" hub topic (created at boot by `ensureAgentAttentionTopic`, state key `agent-attention-topic`, resolved live via a new injected `getAttentionHubTopicId` accessor wired at both TelegramAdapter construction sites in `src/commands/server.ts`). No per-item forum topic is ever created in this mode. `'per-item'` restores the legacy behavior byte-for-byte (still shaped by `attentionTopicGuard` + `topicCreationBudget`). If no hub id resolves or the hub send fails, the adapter finds-or-creates the hub once (create-once + in-flight-promise, mirroring the agent-health lane) — never a per-item topic. Hub-routed items are marked `coalesced` and deliberately NOT registered in the per-item topic maps. Files: `src/messaging/TelegramAdapter.ts`, `src/commands/server.ts`, `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts` (CLAUDE.md awareness parity), docs (`STANDARDS-REGISTRY.md`, `attention-topic-flood-guard.md` addendum), and tests across all three tiers. Trigger: operator directive, topic 11960, 2026-07-09 — ~317 junk topics from slow-drip alert sources that never trip the burst guard.

## Decision-point inventory

- `TelegramAdapter.createAttentionItem` routing branch — **modify** — chooses WHERE an alert surfaces (hub message vs per-item topic); never whether it surfaces.
- `AttentionTopicGuard` decide() at createAttentionItem — **pass-through** — unreached in single-topic mode; unchanged and load-bearing in legacy mode.
- `topicCreationGuard` ceiling inside createForumTopic — **pass-through** — unchanged; hub creation uses the exempt `origin:'system', bounded:true` class (fixed cardinality: one hub).
- Agent-health lane branch — **pass-through** — unchanged; still takes precedence for `lane:'agent-health'` items.
- `updateAttentionStatus` topic close/reopen — **pass-through** — hub items are absent from `attentionItemToTopic`, so resolving one never closes the shared hub (same mechanism the coalesce path already relies on).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No input is rejected. Every attention item is still accepted, stored, and delivered. The nearest thing to an over-block is a VISIBILITY reduction: a HIGH/URGENT alert no longer gets its own topic (it is a hub message with a priority emoji). That is the deliberate, operator-directed behavior, not a side effect — and the per-item carve-out remains available via the legacy mode.

---

## 2. Under-block

**What failure modes does this still miss?**

- A deleted-hub + stale-registry edge: if the user deletes the hub topic in Telegram AND the adapter's topic registry still holds the hub name, `findOrCreateForumTopic` can return the dead id; the send fails, the cached id is dropped, and the item remains store-only until the registry entry is corrected (same semantics the agent-health lane already has). No item is lost; delivery degrades to the store + dashboard.
- The hub can accumulate many messages under a pathological flood (there is no per-hub message rate cap). That is Telegram messages in ONE topic — exactly the surface the directive asks for — and upstream emitters remain bounded by their own dedup/aggregation rules. No issue identified beyond this accepted shape.

---

## 3. Level-of-abstraction fit

The change sits at the exact chokepoint where per-item topics were born (`createAttentionItem`), which is the layer the Bounded-Notification-Surface standard names for this class of fix. It does not re-implement any primitive: hub resolution reuses the boot topic + StateManager key; self-heal reuses `findOrCreateForumTopic`; delivery reuses `sendToTopic`. The flood guard stays at its layer for the legacy mode rather than being deleted — the default simply stops reaching it for attention items.

---

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — this change has no block/allow surface.

The routing branch holds no blocking authority: it decides destination, not permission. Every failure path fails toward delivery (self-heal hub creation) or toward durable recording (attention store) plus a DegradationReporter signal — never toward silent suppression of content.

---

## 5. Interactions

- **Shadowing:** the single-topic branch runs AFTER the agent-health lane (lane wins, unchanged) and BEFORE the flood guard (guard unreached in default mode — intended; it still runs in legacy mode). Verified order in `createAttentionItem`.
- **Double-fire:** no other component posts attention items to the hub; `CrossPlatformAlerts.alertOnTelegram` already targets the same hub via `getAlertTopicId` for a different event class (adapter disconnects) — both are plain messages into one topic, no conflict.
- **Races:** concurrent first-items share ONE in-flight hub creation via `attentionHubPending` (the same promise-guard pattern as the agent-health lane and flood-notice topics). The `attentionItemToTopic` map is untouched for hub items, so no reverse-map corruption (the exact hazard the coalesce-path comment documents).
- **Feedback loops:** none — routing output does not feed any input of the attention system.

---

## 6. External surfaces

- **Telegram:** user-visible change — alerts appear as messages in the existing "🔔 Attention" topic instead of new topics. This is the requested behavior.
- **API consumers:** `AttentionItem.topicId` now points at the shared hub and `coalesced: true` is set (the shape the coalesce path already produced); `/attention` routes, dashboard, and pool reads are unchanged. `/ack`-family commands inside the hub topic are no-ops for hub items (as they already were for coalesced items) — management is via `/attention` PATCH / dashboard.
- **Slack:** verified — the Slack attention surface already routes to the single `slack-attention-channel`; no per-item surfaces exist there. No change.
- **Operator surface (Mobile-Complete):** no new operator-facing action; no dashboard change required. The dashboard attention tab continues to manage items.

---

## 6b. Operator-surface quality

No operator surface touched — not applicable (no dashboard/approval/form files staged).

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, matching the existing attention-topic architecture:** each machine's TelegramAdapter holds its own attention store, and the hub topic id lives in each machine's StateManager under `agent-attention-topic` (the boot path already ensures it per machine; all machines share ONE Telegram chat, and `findOrCreateForumTopic` name-matching keeps them converging on the same hub topic rather than minting one per machine). The pool-wide question ("what needs my attention across machines?") is already answered by the proxied-on-read `GET /attention?scope=pool`, which is unchanged. User-facing notices: this change REDUCES notice surface (one topic); one-voice gating is unaffected because delivery still flows through the same adapter send funnel. No URLs generated; no durable state strands on topic transfer (attention items were never topic-transferable state).

---

## 8. Rollback cost

- **Hot-fix release:** pure code-default change — revert and ship a patch, or flip `messaging[].config.attentionRouting = { "mode": "per-item" }` per agent (live rollback lever, no code).
- **Data migration:** none. No persistent state format changes; hub-routed items reuse the existing `coalesced`/`topicId` fields.
- **Agent state repair:** none. The CLAUDE.md awareness migration is idempotent text replacement.
- **User visibility:** rollback restores per-item topics going forward; hub messages already posted stay in the hub (harmless history).

---

## Conclusion

The review confirmed the design rides existing, battle-tested patterns (boot hub + injected resolver, create-once promise guard, coalesced-item map exclusion) and holds no blocking authority. One design choice was re-verified against the hazard comment in the coalesce path: hub items must NOT enter the per-item topic maps, or resolving one item would close the shared hub — the implementation and a dedicated unit test pin this. Clear to ship; the legacy mode plus a one-key rollback bound the blast radius.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, fresh context, artifact + diff only)
**Independent read of the artifact: concur**

Verbatim verdict core: "Concur with the review." The reviewer independently verified against the working-tree diff: (1) the no-drop guarantee — the store write is unconditional after `routeToAttentionHub`, whose injected-send, `ensureAttentionHubTopic`, and fallback-send paths are all caught, with store-only degradation carrying a DegradationReporter signal; (2) hub-close immunity including across restart — hub items never enter the per-item maps, and the pre-existing `!item.coalesced` guard in `loadAttentionItems` keeps that true after a reload; (3) bounded self-heal — `findOrCreateForumTopic` with the budget-exempt bounded/system class, same name + label as the boot path, shared in-flight promise; (4) branch order and legacy fidelity — the agent-health lane runs first, and the `'per-item'` path is byte-for-byte unchanged.

Three non-blocking observations were raised; ALL THREE were folded into this change rather than deferred: (1) fresh-install race where a self-healed hub could be duplicated by the boot path → `ensureAgentAttentionTopic` now uses `findOrCreateForumTopic` (reuse-by-name, intro message only on a genuinely new topic); (2) the injected accessor was the one call outside a try/catch → now wrapped, making the no-drop claim injector-independent; (3) the migrator's in-place patch left the old "Default-ON" bullet on previously-migrated agents → the patch now rewrites that stale bullet too (covered by a new migrator test).

---

## Evidence pointers

- `tests/unit/attention-single-topic-routing.test.ts` — all-priorities hub routing, zero topic creation, hub-close immunity, self-heal (null id + dead hub), legacy byte-for-byte, lane precedence, server.ts wiring (both construction sites).
- `tests/integration/notification-flood-burst-invariant.test.ts` — SHIPPED DEFAULT burst: 1,000 mixed-priority items → ≤1 topic; legacy-mode guard invariants preserved under `attentionRouting.mode:'per-item'`.
- `tests/e2e/attention-topic-flood-guard-lifecycle.test.ts` — stock production config (token+chatId only): slow-drip 40 alerts → exactly ONE hub topic; legacy opt-out still capped at budget+1.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — the change alters product-source routing behavior (a code default), not a defect in an LLM prompt, hook, config, skill, or standards text.

For the `unbounded-self-action` class (the added diff introduces `sendToTopic`/`findOrCreateForumTopic` emit callsites), the trace carries the explicit NEGATIVE declaration: `{ "defectClass": "unbounded-self-action", "closure": "n/a", "reason": "caller-driven delivery-path routing inside the existing createAttentionItem funnel — not a new self-triggered controller/loop; emission is one hub message per item (replacing one TOPIC per item, a strict reduction), and hub creation is bounded create-once behind an in-flight-promise guard" }`. No new self-triggered controller is added or modified; the controllers that CALL createAttentionItem are unchanged and separately registered.
