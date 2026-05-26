---
name: threadline-notification-routing
review-convergence: 2026-05-25T22:00:00Z
approved: true
eli16-overview: THREADLINE-NOTIFICATION-ROUTING-ELI16.md
---

# THREADLINE-NOTIFICATION-ROUTING-SPEC

**Status:** DRAFT — pre-convergence
**Author:** Echo · **Date:** 2026-05-25 · **Base:** JKHeadley/main @ v1.2.81
**Tracks:** CMT-519 · topic 12304 · follows [[bug_threadline_reply_surface_live_inject]] (PR #390)

---

## 1. Problem

Two operator-reported problems (topic 12304, screenshots 2026-05-25):

**P1 — Topic spam.** Threadline-related notifications create a brand-new Telegram forum topic *per event*, producing a wall of throwaway topics ("Threadline conversation loop wound down" ×N, "Spawn-storm on codey↔echo", "instar-codey cannot spawn to RECEIVE inbound…"). Mechanism: `TelegramAdapter.createAttentionItem` (TelegramAdapter.ts:3067) calls bare `createForumTopic` — **one new topic per attention item, by design** (the Attention Queue tracks each item's status in its own topic). Threadline events that flow into the Attention Queue therefore each spawn a topic:
- **Confirmed in-code caller:** the loop-gate wind-down at `src/commands/server.ts:7167` (`category:'threadline-loop-gate'`) calls `createAttentionItem` directly.
- **Ad-hoc callers:** the spawn-storm / "cannot spawn" topics were posted via the generic `POST /attention` route (`category:'general'`) during the incident (by an agent or job reacting to it) — same per-item-topic outcome.

This is the exact failure the **SentinelNotifier already solved** for sentinels (`src/monitoring/SentinelNotifier.ts:18-22`: "the old path went through /attention → createAttentionItem → createForumTopic, one topic per event, which produced the wall of … topics" → fixed by coalescing to ONE reused system topic). Threadline needs the same treatment. It also matches the operator's earlier CMT-509 line: *"Threadline notifications must NOT be mixed into the generic attention list."*

**P2 — "Open this" is unwired.** The single "Threadline" hub topic (CollaborationSurfacer, `dedicatedTopicId` in `collaboration-surface.json`) surfaces parentless conversations with advisory text *'…or say "open this" to engage'* (CollaborationSurfacer.ts:100). But **no handler interprets "open this"** — a repo-wide search finds the string only as prompt text. So when the operator says "open this" in the hub, the agent just replies inline, cluttering the hub instead of promoting the conversation into its own topic.

## 2. Desired model (operator's words)

- A threadline conversation **with a parent topic** → all its notifications go to that parent topic. Nowhere else.
- A conversation **with no parent** → surfaces in the ONE "Threadline" hub topic — never a per-event topic.
- From the hub, per surfaced conversation, the operator can:
  - **"open this"** → create a fresh topic and **bind** the conversation to it (future updates flow there), OR
  - **"tie this to &lt;existing topic&gt;"** → bind the conversation to a named existing topic.

## 3. Goals / Non-goals

**Goals:** (1) no threadline notification ever spawns a per-event topic; all route parent-or-hub. (2) the loop-gate (and any threadline notifier) uses the routing path, not `createAttentionItem`. (3) "open this" / "tie this to X" in the hub promote/bind a conversation. (4) a structural guard so threadline alerts can't regress into per-event topics.

**Non-goals:** changing the general Attention Queue's per-item-topic behavior for genuinely general items (worktree-misplaced, user decisions — those legitimately want their own status-tracked topic); cross-machine relay changes; the SessionReaper ([[project_sessionreaper_initiative]]).

## 4. Design

> **CONVERGED v2 note:** §8 (Convergence findings) is authoritative where it conflicts with the draft below. Net changes from convergence: (a) do NOT add a new `ThreadlineNotificationRouter` class — extend `CollaborationSurfacer` with a `notify()` entry; (b) classify emitters *content* vs *status* — content (real replies) → parent topic via the EXISTING TopicLinkageHandler (one emitter per topic), status/housekeeping → the SILENT hub only, never the parent (D1); (c) the hub stays silent with no "waiting" nudge; silence breaks only for genuine user-facing escalations (D2); (d) the bind endpoint is an authoritative override; (e) close the §8 gap-list (/attention threadId field, TelegramBridge carve-out, name-collision, schema migration, template + e2e-alive).

### Fix 1 — extend `CollaborationSurfacer` (single funnel, parent-or-silent-hub)

New class `src/threadline/ThreadlineNotificationRouter.ts`. One method:

```ts
route(input: { threadId: string; title: string; body: string; peerName?: string }): Promise<{ surfacedTo: 'parent-topic' | 'hub' | 'suppressed'; topicId?: number }>
```

Resolution:
1. `boundTopicId = conversationStore.get(threadId)?.boundTopicId` → if set, post to that **parent topic** (`sendTelegramToTopic`). Done.
2. Else delegate to the existing **CollaborationSurfacer** hub path (single `dedicatedTopicId`, deduped). 
3. **Never** calls `createAttentionItem` / `createForumTopic` per event.

Coalescing + rate-limit mirror SentinelNotifier + the existing CollaborationSurfacer dedupe (per-thread one-surface; repeat posts on an already-surfaced thread are suppressed). This is a **delivery sink, not a gate** — no new blocking authority (signal-vs-authority compliant).

### Fix 2 — migrate the loop-gate to the router

`src/commands/server.ts:7167`: replace the `telegram.createAttentionItem({... category:'threadline-loop-gate' ...})` call with `threadlineNotificationRouter.route({ threadId: gateThreadId, title:'Threadline conversation loop paused', body:'…', peerName: senderName })`. The loop-gate thread usually has a boundTopicId (it was an active conversation) → routes to the parent topic; else the hub.

### Fix 3 — structural guard on `POST /attention`

In the `/attention` route (routes.ts ~5602), detect threadline-class categories (`/^threadline|inter-agent|relay|spawn/i` on `category`) and **redirect** them through `ThreadlineNotificationRouter` instead of `createAttentionItem` (requires a `threadId`/`relatedThreadId` in the payload; if absent, route to the hub). This makes the no-per-event-topic property structural — even an agent ad-hoc-posting a threadline alert can't spawn a topic. (Redirect + log, not a hard block — signal-vs-authority.)

### Fix 4 — "open this" / "tie this to X" hub interaction

The hub surfaces conversations; the surfacer already tracks `surfacedThreads`. Extend `collaboration-surface.json` to record, per surfaced thread, `{ threadId, peerName, subject, surfacedAt, bound: boolean }`, and the **most-recently-surfaced unbound thread** for the hub.

New endpoint `POST /threadline/hub/bind` `{ action: 'open' | 'tie', threadId?: string, targetTopicId?: number, targetTopicName?: string }`:
- `open` (no target): `findOrCreateForumTopic(<subject or "<peer> · Threadline">)` → `conversationStore.mutate(threadId, c => { c.boundTopicId = newTopicId })` → post a confirmation in the new topic ("This Threadline conversation with &lt;peer&gt; is now here.") and a one-line note in the hub ("Opened → topic &lt;name&gt;"). Future notifications route to the new parent topic via Fix 1.
- `tie` (target topic): same bind to the existing `targetTopicId`/resolved-by-name.
- `threadId` defaults to the hub's most-recently-surfaced unbound thread when omitted (the common "open this" case).

**Agent-facing wiring (Structure > Willpower):** the session-start / CLAUDE.md hub guidance tells the agent: when a user says "open this" / "tie this to X" in the Threadline hub topic, call `POST /threadline/hub/bind`. (The agent identifies intent; the endpoint does the structural bind — the agent never hand-rolls topic creation.) **Convergence question:** should "open this" be a structural command intercepted before the agent (deterministic), or agent-interpreted-then-endpoint? Lean: agent-interpreted + endpoint (handles "tie this to my GrowthBook topic" natural language), with the endpoint as the single mutation path.

## 5. Test strategy (3-tier + test-as-self)

**Unit:** `ThreadlineNotificationRouter.route` → bound thread posts to parent topic (not hub, not createForumTopic); unbound → hub; never calls createAttentionItem. `/attention` threadline-category redirect. Hub `bind` open → new topic + boundTopicId set; tie → existing topic bound; open-with-omitted-threadId → most-recent unbound.
**Integration:** loop-gate budget-exhaustion path posts via router to parent/hub, asserts NO new forum topic created. `POST /threadline/hub/bind` end-to-end sets boundTopicId + subsequent notification routes to the bound topic.
**E2E (wiring):** router + hub-bind endpoint constructed/wired in the boot path; `sendTelegramToTopic`/conversationStore non-null.
**Test-as-self (mandatory):** deploy to live Codey; trigger a parentless threadline surface (hub gets ONE post, no per-event topic); drive "open this" → confirm a new topic is created + bound + the next notification lands there, not the hub; confirm a loop-gate wind-down routes to parent/hub not a new topic. Restore Codey, then merge.

## 6. Migration parity

Pure `src/` + a new CLAUDE.md hub-guidance section (Agent Awareness Standard) — add via `migrateClaudeMd()` content-sniff so existing agents learn the "open this" → endpoint behavior. New `ThreadlineNotificationRouter` constructed in boot path. No config/hook changes.

## 7. Side-effects (to expand in the artifact)

Over-surface (router posts where createAttentionItem was suppressed by tone gate?) — route through the same outbound checks; under-surface (a genuinely user-critical threadline alert that wanted its own tracked topic — none identified; parent/hub is the operator's stated preference); interaction with the general Attention Queue (general items unchanged); "open this" mis-binding the wrong conversation (mitigated by most-recent-unbound default + explicit threadId option). Rollback: localized to the new router + loop-gate callsite + the hub-bind endpoint.

## 8. Convergence findings (2 reviewers, 2026-05-25) — to incorporate into v2

**Design simplification (accepted):**
- **Collapse the new class.** Do NOT add a parallel `ThreadlineNotificationRouter`; EXTEND `CollaborationSurfacer` with the bound-vs-hub dispatch (it already owns the hub; TopicLinkageHandler already owns parent-topic content). One funnel, not three.

**Two PRODUCT decisions sent to operator (topic 12304) — block v2 finalization:**
- **D1 — status notices destination. RESOLVED 2026-05-25 (operator: "agreed").** Classify emitters: *content* (actual agent replies) → parent topic via the existing TopicLinkageHandler (one emitter per topic — no second emitter, fixes H2). *status/housekeeping* (loop-gate "stopped looping", spawn-storm, etc.) → hub-only, coalesced, NEVER the parent topic the operator is actively working in. The loop-gate (Fix 2) therefore routes to the hub, not the parent.
- **D2 — hub visibility. RESOLVED 2026-05-25 (operator).** The hub stays SILENT — agent-to-agent conversations do NOT need the user by default, so they must not be framed as "waiting for you" and must not buzz or nag. The hub is a calm, browsable record. NO "N waiting" nudge. Silence is broken ONLY when a threadline conversation produces something that genuinely needs the user (a question/decision aimed at the operator) — that escalation surfaces normally in the relevant topic, exactly like a user-facing reply (this is the *content/escalation* class, not *status*). "open this" / "tie this to X" are user-initiated whenever the operator chooses to glance at the hub.

**Gaps to close in v2 (no operator input needed):**
- **Q4/M5 — `POST /attention` has no `threadId` field** (routes.ts:5601). Fix 3 redirect must add `threadId`/`relatedThreadId` to the route+type, else ad-hoc threadline-category posts route hub-only (coalesced "Threadline activity"). Sniff title/summary too (category alone misses `general` spawn-storm posts).
- **Q5 — `TelegramBridge.mirrorInbound` (TelegramBridge.ts:225) creates per-thread topics** via `findOrCreateForumTopic`. Default-OFF + allow/deny-gated, but contradicts Goal #1 — carve out explicitly as opt-in or fold into the funnel.
- **Q5 — `findOrCreateForumTopic` matches by name** — "open this" with `findOrCreateForumTopic(<subject>)` could reuse/cross-bind two same-subject conversations. Use a unique topic name (include peer + short threadId) or an explicit create.
- **H3 — `POST /threadline/hub/bind` must be an AUTHORITATIVE override** — `captureOriginOnSend`'s first-write-wins anti-poisoning (TopicLinkageHandler.ts:214) would silently refuse a manual bind if a commitment already recorded a different topicId. Operator intent > heuristic: update ConversationStore AND the commitment's topicId.
- **C1/Q2 — "open this" mechanism** relies on the hub topic auto-spawning a session on inbound (server.ts:1338-1364) — document + test this dependency. `SurfaceState` schema must extend `surfacedThreads: string[]` → records `{threadId, peerName, subject, surfacedAt, bound}` with a **read-time migration** in `CollaborationSurfacer.load()` (L6). Disambiguation: explicit `threadId` required when >1 unbound thread; most-recent-unbound only for the single-conversation case.
- **Q6 — Agent Awareness + Testing Integrity:** update the live `generateClaudeMd()` template (`src/scaffold/templates.ts`), not just `migrateClaudeMd()`. `POST /threadline/hub/bind` needs an E2E "alive" (200-not-503) test + a null-telegram 503 degraded path.

**Accepted as-is:** loop-gate losing /ack status tracking is fine for a LOW FYI (Q3); AgentWorktreeDetector + general /attention items stay per-topic (non-goal); DigestCollector/ApprovalQueue/DeliveryFailureSentinel surveyed — no per-topic threadline emitters found.
