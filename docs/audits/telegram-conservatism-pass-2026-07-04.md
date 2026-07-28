# Telegram Conservatism Audit — Auto-Topic & Proactive-Message Paths (2026-07-04)

**Author:** Echo (instar-dev) · **Topic origin:** operator directive 2026-07-01, re-authorized 2026-07-04 (frontload item #4).
**Scope:** every code path that (a) auto-creates a Telegram forum topic, or (b) sends an unsolicited/proactive message to the user. Classify each against the operator's two invariants and identify the structural gaps.

## The directive (operator, verbatim 2026-07-01)

> "Be extremely conservative with what messages get sent to Telegram… almost all messages should be assumed to be messages the agent should ACT ON, not that the user should know about… messages should NOT create their own topics… should go to one single topic for user alerts. This applies to ALL aspects of INSTAR."

Three invariants fall out of this:

1. **Act, don't notify.** The default disposition for any candidate outbound is *the agent acts on it*, not *the user is told*. A notification must clear a bar: it genuinely needs the human.
2. **No new auto-topics.** Automatically-created topics are forbidden except for a small fixed set of bounded, create-once system topics.
3. **Single alert topic.** An ownerless notice routes to the ONE dedicated alerts/hub topic, never a fresh per-event topic.

This audit found this directive has the **weakest structural follow-through** of any critical operator item (topic-29836 audit): the machinery that exists (below) is real, but a load-bearing bypass leaves invariants #2/#3 dodgeable.

## Existing machinery (verified sufficient where noted)

| Layer | Component | Verdict |
|---|---|---|
| Shaper | `AttentionTopicGuard` at `createAttentionItem` — per-source + global budget; coalesces overflow into ONE "notices coalesced" topic | Sufficient for NORMAL/LOW attention items |
| Backstop | `topicCreationBudget` inside `createForumTopic` — last-resort ceiling | **Dodgeable** — see Gap 1 |
| Emitter aggregation | `AgentWorktreeDetector` pattern (one item carrying the count) | Sufficient where applied |
| Ratchet | `tests/integration/notification-flood-burst-invariant.test.ts` | Extended by this pass |
| Sentinel routing | `SentinelNotifier` (log-only default; Telegram opt-in, coalesced to Lifeline) | Sufficient |
| Alert topic | Agent Attention / Lifeline / Updates fixed topics | Sufficient |

## Enumeration (from a full `src/` sweep, excl. `*.test.ts`)

### A. `createForumTopic` / `findOrCreateForumTopic` callers, by `origin`

**Create-once fixed system topics (`origin:'system'` — BYPASSED the ceiling):**
- `TelegramAdapter.ensureLifelineTopic` (`:1561`, `:1595`) — the fixed Lifeline topic.
- `TelegramAdapter.ensureDashboardTopic` (`:1701`, `:1753`) — the fixed Dashboard topic.
- `TelegramAdapter.ensureAgentHealthLaneTopic` (`:3963`) — the reused "🩺 Agent Health" lane (overflow surface).
- `TelegramAdapter.ensureFloodNoticeTopic` (`:4068`) — the reused "notices coalesced" topic (overflow surface).
- `server.ts ensureAgentAttentionTopic` (`:2578`), `ensureAgentUpdatesTopic` (`:2658`) — the fixed Attention / Updates boot topics.

All are legitimately **cardinality-bounded by design** (create-once-then-reuse). They *should* be exempt — but they were exempt only via the same `origin:'system'` flag that ALSO exempted an unbounded per-item path (below).

**Per-item attention topics (the unbounded hole):**
- `TelegramAdapter.createAttentionItem` (`:3823`) — `origin: critical ? 'system' : 'auto'`. Non-critical rode the `'auto'` budget; **HIGH/URGENT rode `'system'` → no ceiling at all.** A stream of distinct HIGH/URGENT items (each a novel title) spawned unbounded topics. This is the concrete path a topic slipped past the guards through.

**Budgeted `'auto'` callers (bounded — correct):**
- `JobScheduler` (`:1513`, `:1533`, `:1613`) — per-job topics, label `job-topics`.
- `threadline/TelegramBridge` (`:226`) — per-inbound-thread, gated by `autoCreateTopics`.
- `threadline/CollaborationSurfacer` (`:202`) — collaboration threads.

**User-initiated (`origin:'user'` — exempt, correct):** hub bind commands, `/topic` API routes, session-topic provisioning.

**Raw Telegram-API bypass (noted, low-risk):**
- `lifeline/TelegramLifeline.ts` (`:2685`) — the lifeline process creates its own Lifeline topic via the raw `createForumTopic` API, bypassing the adapter chokepoint. Create-once + a separate process; documented, not fixed here (tracked follow-up). <!-- tracked: CMT-1901 -->

### B. `createAttentionItem` callers (each spawns one topic/item; HIGH/URGENT were never coalesced)

~30 call sites across `server.ts` and `routes.ts` (role-guard, resume-queue drain, account-follow-me consent, PromiseBeacon escalation, collaboration-redrive, a2a-redelivery, subscription-pool, GreenPR degradation, working-set recovery, Threadline pairing-MITM, single-negotiator fail-open, UltraSessionCapMonitor, GuardPostureTripwire, StaleSessionBackstop, …). Most emit at LOW/NORMAL and are shaped by `AttentionTopicGuard`. The **HIGH-priority emitters** (account-follow-me, PromiseBeacon, subscription-pool, Threadline pairing/negotiator, UltraSessionCap) each got their **own unbounded topic** pre-fix.

### C. Proactive `sendToTopic` / `sendMessage` / `sendToOwnerDM` (not a reply)

All verified to target an **existing** topic (the session's own topic, the Lifeline/system topic, or a fixed alert topic) and **never create** a topic:
- Session-health: `SessionMonitor`, `PresenceProxy`, `PromiseBeacon`, `AutonomousProgressHeartbeat`, `StallTriageNurse`, `TriageOrchestrator` → session's own topic.
- Sentinels: `SentinelNotifier` / `sentinelConsolidatedSend` (log-only default; coalesced to Lifeline when enabled), `RateLimitSentinel` → session/Lifeline.
- Reap: `ReapNoticeDrain`, `ReapNotifier` → reaped session's topic / Lifeline.
- Quota: `QuotaNotifier` → single fixed alert topic.
- Tunnel: `TunnelManager` → owner DM.
- Growth: `GrowthDigestPublisher` → single Updates topic via the post-update funnel.

**Verdict for Category C: already conforms** to invariants #2/#3 (existing-topic-or-fixed-alert-topic, never a new topic).

### D. `/telegram/post-update`

Route `routes.ts:10392` resolves the target topic **server-side** to the single fixed Updates topic; the caller cannot specify a topic; a missing Updates topic returns 400 (no fallback to another topic). **Conforms.**

## Gaps found

- **Gap 1 (load-bearing) — the `origin:'system'`/`'user'` ceiling bypass.** `createForumTopic` applied the last-resort ceiling **only when `origin === 'auto'`**. Any caller could dodge the "universal" ceiling entirely by declaring `origin: 'system'`. The *Bounded Notification Surface* standard's own claim — "covers every caller, current and future, no matter what source labels it passes" — was **false**. This is the exact 2026-06-05 dodge one level up: instead of varying a source *label*, a caller varies its *origin*.
- **Gap 2 (the concrete leak) — HIGH/URGENT attention items were unbounded.** `createAttentionItem` used `origin:'system'` for critical items AND `AttentionTopicGuard` never coalesces critical items. So a per-item critical stream had **zero** ceiling — "mark it HIGH" was an unbounded-topic bypass. This is the most likely mechanism by which a topic was auto-created mid-session despite the guards.
- **Gap 3 (disposition, not code) — no "act-don't-notify" standard.** The two existing standards bound topic *volume* and *routing*; neither states the operator's primary point: the *default* for a candidate outbound is that the agent ACTS, not notifies. This is captured as a proposed standard (below), not code.
- **Gap 4 (noted, deferred) — the raw-API lifeline bypass** (Cat. A). Create-once, separate process — low risk, tracked, not fixed here. <!-- tracked: CMT-1901 -->

## Fixes implemented in this pass

1. **Closed the bypass (Gap 1).** `createForumTopic` now applies the ceiling to **every** origin except (a) an explicit human request (`origin:'user'`) and (b) a caller that **declares** its topic is cardinality-bounded (`bounded: true`). A bare `origin:'system'` is now budgeted exactly like `'auto'`. Structure over willpower: the ceiling can no longer be sidestepped with a label.
2. **Marked the genuine create-once system topics `bounded: true`** (Lifeline, Dashboard, Agent-Health lane, flood-notice, boot Attention/Updates) so they stay exempt — including the overflow surfaces the ceiling must never refuse.
3. **Bounded the critical stream (Gap 2)** with a distinct budget label (`attention-item-critical`) so a lone emergency amid LOW noise still gets its own topic (visibility preserved up to a generous ceiling), while a genuine FLOOD of critical items is bounded — and on ceiling-refusal, **coalesces into the single notices topic** (still delivered, still in the attention store) instead of degrading silently.
4. **Extended the burst-invariant ratchet** to fail the build if a bare `origin:'system'` caller can flood, and to prove a 1,000-item HIGH/URGENT stream stays bounded and never drops an item.

## Proposed standard (operator ratifies)

`### Conservative Outbound: Act, Don't Notify` in `docs/STANDARDS-REGISTRY.md` — the disposition layer that sits above the two existing volume/routing standards. Marked `⚠ PROPOSAL — awaiting operator ratification`.

## Tracked follow-ons (not silently dropped)

- Raw-API lifeline bypass (Gap 4) — `<!-- tracked: CMT-1901 -->` (self-inflicted-loops / capacity-safety class).
- A routing-chokepoint assertion that an *ownerless* proactive `sendToTopic` defaults to the alerts topic by construction (the "Notices Route to the Alerts Topic" enforcement build) — `<!-- tracked: CMT-1901 -->`.
