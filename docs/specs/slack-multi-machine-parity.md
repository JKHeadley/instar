---
kind: "spec"
id: "slack-multi-machine-parity"
title: "Slack Multi-Machine Parity (promote the notification/attention/lifecycle/swap surfaces from TelegramAdapter to the base interface, with a real SlackAdapter implementation)"
summary: "The entire multi-machine + notification UX (attention items, coalescing/notice routing, session-lifecycle incl. restart-all, topic/conversation swap between machines) lives ONLY on TelegramAdapter and keys on positive Telegram topic ids. Slack is a first-class chat adapter but a non-participant in that UX: SlackAdapter implements NONE of it, callers hardwire ctx.telegram, restart-all filters to Telegram-bound sessions, pool-transfer keys on numeric topicId, and no durable Slack conversation id is exercised (/conversations/health entryCount:0). This spec promotes the multi-machine-relevant surfaces to the base MessagingAdapter interface, gives SlackAdapter a Slack-native implementation of each (channel/thread + Block Kit, no forum-topic assumption), exercises the already-built ConversationIdentity negative-id minting for Slack channels/threads, and defines the Slack analog of a topic-swap. Live-verifiable with Slack enabled:true and real test users (EXO 3.0 / Live-User-Channel-Proof), not just Telegram."
status: draft
author: Echo
date: 2026-07-03
risk-class: "additive-then-migrating — new base-interface capabilities + a Slack implementation are additive (existing Telegram behavior is byte-identical when the router still resolves the Telegram adapter). The one behavior-changing step is repointing callers from ctx.telegram.createAttentionItem to a platform-resolved adapter; guarded so an unresolved/absent Slack adapter falls back to today's Telegram-only path (Slack-off installs unchanged)."
parent-principle: "Adapter-pattern abstraction (CLAUDE.md Key Design Decision 3: 'the interface supports any platform') + Goal A (premier AI employee in Slack) + Goal B (one coherent agent across machines) + Live-User-Channel-Proof Before Done."
lessons-engaged:
  - "Structure > Willpower: a base-interface CONTRACT + a conformance suite makes 'Slack is at parity' a compile-and-CI fact, not a reviewer's memory. A capability that lives only on the concrete TelegramAdapter is invisible to every other adapter by construction — the fix is to move the contract to the interface."
  - "Live-verify multi-machine (memory live-verify-multimachine): a Slack-parity claim proven only by Telegram tests or synthetic Slack mocks gives false confidence. The completion gate REQUIRES a real Slack workspace with real test users driving the real Slack surface (EXO 3.0 operator directive)."
  - "Notification-flood discipline (CLAUDE.md Bounded Notification Surface): the Telegram model is one-forum-topic-per-attention-item; Slack has channels/threads and NO forum-topic primitive. A naive port would either spam channels or lose the coalescing guard. The Slack implementation MUST carry its own bounded-notification analog (one system channel + threaded/coalesced items), not assume the topic model."
  - "Know Your Principal: operator-binding and approved-sender resolution must come from an AUTHENTICATED Slack identity (Slack user id / team id), never a display name in content — the same rule the Telegram path enforces. Slack principal resolution already exists (SlackPrincipalResolver); the swap/lifecycle surfaces must consult it, not invent a parallel identity."
  - "Stale-audit caveat: the 2026-07-03 seamlessness audit ran against a ~525-version-stale clone; several 'absent' findings (ConversationIdentity Slack minting) are in fact PRESENT-BUT-UNEXERCISED on current main. This spec re-grounds every claim against main @ v1.3.737 and flags where the audit was superseded."
single-run-completable: false
---

# Slack Multi-Machine Parity

**Status:** DRAFT
**Owner:** Echo
**Created:** 2026-07-03
**Goal Alignment:** Goal A (premier AI employee in Slack) — PRIMARY; Goal B (one coherent agent across machines) — enabling.
**Evidence base:** `.instar/roadmaps/seamlessness-audit-2026-07-03.md` (§7 Slack parity), re-grounded against `.dev/instar` **main @ v1.3.737** (the audit ran against a ~525-version-stale clone; see §1.4).

> **Audit re-grounding note.** The seamlessness audit's §7 was produced against a stale clone. Every "absent from source" claim below was re-checked against current `main`. Two audit findings are **superseded**: (a) ConversationIdentity **does** mint negative Slack ids on current main (`src/core/conversationIdentity.ts`, `src/core/ConversationRegistry.ts`) — the gap is that it is **unexercised** (Slack off), not absent; (b) SlackAdapter has richer channel/formatter/principal machinery than the audit saw. The **core structural gaps are confirmed and unchanged** (attention/notice/lifecycle/swap are Telegram-coupled).

## 1. Problem statement

### 1.1 The base adapter interface carries none of the multi-machine surface

`MessagingAdapter` (`src/core/types.ts:765-795`) declares only: `platform`, `start`, `stop`, `send`, `onMessage`, `resolveUser`, plus the optional Channel-Seamlessness contract (`getIngressPosition` / `stopConsuming` / `resumeConsuming` / `dedupeKey`, lines 783-794). It declares **no** attention-item, notice-routing, session-lifecycle, or conversation-swap method. Those live entirely on the concrete `TelegramAdapter`.

### 1.2 Attention/notice creation is Telegram-only and callers hardwire `ctx.telegram`

- `createAttentionItem` is defined **only** on `TelegramAdapter` (`src/messaging/TelegramAdapter.ts:3798`) — verified the sole definition under `src/messaging/` (`grep -rln 'createAttentionItem(' src/messaging/` → `TelegramAdapter.ts` only). It is **not** on the `MessagingAdapter` interface and **not** implemented by `SlackAdapter`.
- Every server-side caller invokes it against the Telegram adapter specifically: `ctx.telegram.createAttentionItem(...)` at `src/server/routes.ts:2258, 4693, 4790, 5066, 5116, 5199, 12299, 12686, 22146` (and the threadline surfacers, `src/threadline/threadSymmetry.ts:275`, `recordThreadMessage.ts:282`). **No caller resolves the adapter by the conversation's platform.** A Slack conversation therefore cannot receive an attention item, a topic-flood-coalesced notice, or a sentinel/reap escalation.
- The whole model is forum-topic-shaped: `createAttentionItem` internally calls `createForumTopic` (`TelegramAdapter.ts:3861`) — one Telegram forum topic per item, with the Bounded-Notification budget enforced inside `createForumTopic` (`TelegramAdapter.ts:108, 478, 1422`). **Slack has channels + threads and no forum-topic primitive**, so the "one topic per attention item" design has no Slack analog to port to directly.

### 1.3 Session-lifecycle (incl. restart-all) explicitly skips Slack

`POST /sessions/restart-all` (`src/server/routes.ts:7651`) filters its targets to Telegram-bound sessions only: it keeps a session only if `ctx.telegram?.getTopicForSession?.(name) ?? ctx.telegram?.resolveTopicForSessionFromDisk?.(name)` resolves non-null (`routes.ts:7674-7681`), and the code comment is explicit: *"Non-Telegram-bound sessions (Slack, iMessage, headless) are skipped — the respawn path is topic-routed, the same v1 limitation as /sessions/refresh"* (`routes.ts:7649-7650`). So a config/model/hook change applied via restart-all never reaches a running Slack session.

### 1.4 Topic/conversation swap keys on numeric Telegram topic ids

Pool placement/transfer keys on a numeric `topicId` (`GET /pool/placement?topic=${topicId}` at `routes.ts:14170, 28615`; the transfer planner threads `topicId` through, e.g. `routes.ts:14443`). Telegram topics **are** their own positive numeric id, so this is implicitly a Telegram id space. A Slack channel/thread is not a positive topic id — it needs the durable **negative** conversation id that `ConversationIdentity` mints (`src/core/conversationIdentity.ts`: canonical key `slack:<teamId>:<channelId>[:<threadTs>]` → `-(abs(hash)+1)`; `ConversationRegistry` binds the tuple to a stable minted negative id). That minting **exists on current main but is unexercised**: the audit read `/conversations/health` → `entryCount:0` (`routes.ts:28704` returns `ctx.conversationRegistry.health().entryCount`) — nothing has ever been minted, because Slack is off and no Slack inbound has driven a `recordSpeculative`/mint. So "move this conversation to the other machine" is undefined for Slack: there is no stable id for durable state (commitments, notices, placement) to attach to, and the transfer planner has no Slack id space to operate in.

### 1.5 SlackAdapter's multi-machine surface is ~empty

`SlackAdapter` (`src/messaging/slack/SlackAdapter.ts:99, implements MessagingAdapter`) has `sendToChannel` (565), `createChannel` (666), `isSystemChannel` (728), and `onStandbyCommand` for `unstick/quiet/resume/restart` (196, 1166). It has **zero** references to pool, mesh, failover, handoff, CONTINUATION, topic-transfer, attention-item, notice-coalescing, or reap-notice delivery. Slack is a non-participant in the entire multi-machine + notification + attention + self-heal UX.

### 1.6 Slack is `enabled:false`

This agent's config has `slack: off`. Goal A ("return to Slack development + automated tests with real users") cannot begin without (a) closing the parity gaps above and (b) standing up a live Slack test workspace with real test users (§7).

**One-line problem:** the multi-machine seamlessness UX is Telegram-shaped and Telegram-coupled at the interface, caller, lifecycle, and id-space levels; Slack must be promoted to a first-class participant so the seamlessness works on Slack, not just Telegram.

## 2. Proposed design

### 2.1 Promote the multi-machine surface to the base `MessagingAdapter` interface

Add a new **optional, opt-in** capability block to `MessagingAdapter` (`src/core/types.ts`), mirroring the existing "Channel Seamlessness Contract" pattern (optional so existing adapters compile unchanged; the seamless paths check for presence). The block is a small, platform-neutral CONTRACT — NOT the Telegram-forum-topic shape:

```ts
// ── Multi-Machine Notification & Lifecycle Contract (optional, opt-in) ──
// An adapter is "multi-machine-ready" only once it implements these AND passes
// the §6 contract-conformance suite. Optional so existing adapters compile
// unchanged; every consumer checks presence before use.
export interface MessagingAdapter {
  // ... existing members ...

  /** Raise an operator-facing attention item on THIS platform, using the
   *  platform's own bounded-notification surface. Telegram → one forum topic
   *  per item (existing behavior). Slack → one system channel, one threaded
   *  message per item, coalesced under load. Returns the platform-neutral
   *  AttentionItem (topicId is the platform-native or minted conversation id). */
  createAttentionItem?(item: Omit<AttentionItem,'createdAt'|'updatedAt'|'status'|'topicId'>): Promise<AttentionItem>;

  /** Deliver a housekeeping/notice message (reap notices, sentinel escalations,
   *  coalesced digests) to THIS platform's system surface, honoring the
   *  platform's coalescing/flood guard. */
  postSystemNotice?(notice: SystemNotice): Promise<void>;

  /** Resolve the durable conversation id for a session on THIS platform
   *  (Telegram: positive topic id; Slack: minted negative ConversationIdentity id).
   *  Replaces the Telegram-only getTopicForSession in cross-platform callers. */
  getConversationForSession?(sessionName: string): number | null;
  resolveConversationForSessionFromDisk?(sessionName: string): number | null;

  /** Whether this session/conversation participates in bulk lifecycle ops
   *  (restart-all). True once the adapter can resume a conversation by id. */
  supportsLifecycleRefresh?(sessionName: string): boolean;
}
```

`AttentionItem` and a new `SystemNotice` type live in a shared location (`src/core/types.ts`) so both adapters produce the same shape. **`TelegramAdapter`'s existing methods become its implementation of this contract** (rename-free where signatures already match; a thin shim where they don't). Telegram behavior is byte-identical.

### 2.2 A real `SlackAdapter` implementation of each surface

- **`createAttentionItem`** — Slack-native. Instead of one forum topic per item, use **one durable system channel** (reuse `isSystemChannel`/`createChannel`, `SlackAdapter.ts:666,728`) and post **one threaded root message per attention item** (Block Kit: title, body, priority color via attachment, an ack action). The Slack analog of the topic-flood budget: a per-source **coalescing thread** (subsequent low-priority items from the same source append as thread replies under a running "notices coalesced" root, mirroring `state/attention-suppressed.jsonl`), while HIGH/URGENT always get their own root message — the same invariant as the Telegram Bounded-Notification guard (`TelegramAdapter.ts:478`). No new channel is auto-created per item (that would be the Slack equivalent of the topic flood).
- **`postSystemNotice`** — deliver reap notices / sentinel escalations / coalesced digests to the Slack system channel, threaded and coalesced identically.
- **`getConversationForSession` / `resolveConversationForSessionFromDisk`** — return the **minted negative ConversationIdentity id** for the session's Slack channel/thread (via `ConversationRegistry`), the durable handle durable state attaches to.
- **`supportsLifecycleRefresh`** — true once the Slack respawn path can resume a conversation by its minted id (§2.4).

### 2.3 Exercise ConversationIdentity minting for Slack (make `entryCount > 0`)

The minting machinery exists (`conversationIdentity.ts`, `ConversationRegistry.ts`, `deliverToConversation.ts`) but is never driven because no Slack inbound flows. Wire the **Slack inbound path** (`SlackForwardBridge` / `SlackAdapter.onMessage`) to call `ConversationRegistry.recordSpeculative(tuple)` on the first message from a `(team, channel, thread?)` tuple, minting the stable negative id. This is the load-bearing enabler: once a Slack channel has a durable id, attention items, commitments, notices, and pool-placement can all attach to it and survive restarts. **Acceptance: after one Slack message with Slack enabled, `GET /conversations/health` reports `entryCount > 0` for a `platform:'slack'` entry.**

### 2.4 Slack-native session-lifecycle participation (restart-all)

Replace the Telegram-specific filter in `/sessions/restart-all` (`routes.ts:7674-7681`) with a **platform-neutral** resolution: a session is a restart-all target if **any** wired adapter's `getConversationForSession?.(name) ?? resolveConversationForSessionFromDisk?.(name)` resolves non-null AND that adapter reports `supportsLifecycleRefresh(name)`. This admits Slack sessions once the Slack respawn path can resume by minted id. **`SessionRefresh`** (`src/core/SessionRefresh.ts`) must gain a Slack resume path (kill + resume a Slack-bound session, re-binding the minted conversation id) analogous to its Telegram `claude --resume` path; the topic-routed assumption in its resolver is the v1 limitation the comment names. Guarded: an adapter that does not implement `supportsLifecycleRefresh` is skipped exactly as today (iMessage/headless unchanged).

### 2.5 Define the Slack analog of a "topic swap between machines"

A topic-swap moves a conversation's serving to another machine, resuming via CONTINUATION. For Slack:
- The unit that moves is the **minted negative ConversationIdentity id** (not a Telegram topic id). `GET /pool/placement?topic=<negId>` and `POST /pool/transfer {topic:<negId>,...}` operate on the minted id unchanged — the id space is already numeric; the transfer planner does not need to know it is Slack (the resolution to a channel/thread happens at the adapter send boundary).
- **Continuity across the move:** the receiving machine resumes the Slack conversation by re-resolving the minted id → `(team, channel, thread?)` tuple (via `ConversationRegistry`) and re-binding its Slack session, then delivers the CONTINUATION exactly as Telegram does. Slack threading maps cleanly IF the conversation is thread-scoped; a channel-scoped conversation maps to the channel root. See **§OQ-1**.
- **Post-transfer closeout:** the old machine closes its Slack-bound session for that id (the same reap-notice + resume-queue machinery, now id-generic rather than Telegram-topic-generic).

### 2.6 Caller repoint: platform-resolved attention/notice dispatch

Introduce a single helper `resolveAdapterForConversation(convId): MessagingAdapter | null` (positive → Telegram; minted negative → the platform recorded in `ConversationRegistry`). Repoint the `ctx.telegram.createAttentionItem` callsites (§1.2) to `resolveAdapterForConversation(convId)?.createAttentionItem?.(...) ?? ctx.telegram.createAttentionItem(...)` — the fallback preserves today's behavior when the conversation has no platform binding or the resolved adapter lacks the method (Slack-off installs are byte-identical). This is the **one behavior-changing edit**; everything else is additive.

## 3. Decision points touched

- **Interface contract shape** (§2.1): optional opt-in methods on `MessagingAdapter`, mirroring the Channel-Seamlessness precedent — chosen over a mandatory interface change (would break WhatsApp/iMessage compile) and over a separate `MultiMachineAdapter` interface (would fragment the adapter registry).
- **Slack notification primitive** (§2.2): one system channel + threaded/coalesced messages, chosen over channel-per-item (flood) and over DM-per-item (loses the shared operator surface).
- **Conversation id authority** (§2.3/§2.5): the minted negative ConversationIdentity id is the single durable handle for Slack — chosen over a parallel Slack-only id scheme (would duplicate ConversationRegistry and re-introduce the drift the mint-idiom ratchet forbids, `conversationIdentity.ts:10`).
- **Caller dispatch** (§2.6): platform-resolved-with-Telegram-fallback, chosen over a hard repoint (would break Slack-off installs).
- **Principal resolution** (§4): reuse `SlackPrincipalResolver`/`SlackUserRegistry` for operator-binding and approved-sender on swap/lifecycle — chosen over inventing a parallel identity (Know Your Principal).

## 4. Multi-machine posture for new state

- **Minted Slack conversation ids** are durable + **content-addressed** (the canonical key is deterministic, so two machines minting the same `(team, channel, thread?)` tuple independently collapse to the SAME id — no per-machine divergence). `ConversationRegistry` HAS the replication-aware framing designed in (`adopted-replicated`/`replicated` origins, treated as untrusted/advisory, `ConversationRegistry.ts:53`), **but that path is NOT wired today** (no replication `JOURNAL_OPS` op, no ingest method; `multiMachine.stateSync.conversations` is unbuilt — see FD-4). So a minted id resolves correctly on a machine that ITSELF minted it (deterministic re-mint from the same inbound), but a mint made ONLY on machine A does not appear in B's registry until the FD-4 replication increment ships. This spec does NOT assume the registry replicates; cross-machine resolution is the named FD-4 follow-on.
- **Attention items / notices** raised on a Slack conversation are **machine-local delivery** (the machine currently serving the conversation posts to Slack), but the attention STORE entry is the existing durable/poolable one — `GET /attention?scope=pool` already merges across machines; a Slack-sourced item must carry the minted id so the pool view is coherent (see §OQ-5).
- **Operator binding from an authenticated Slack identity** is per-conversation and must replicate as advisory (the WS2.6 topic-operator PII rule): a replicated Slack operator binding is untrusted context, never the authoritative answer to "who is my verified operator" — the local authenticated binding wins (Know Your Principal, CLAUDE.md WS2.6).
- **Single-machine agents:** every new surface is a strict no-op relative to today when only one machine is online — the value is only realized on the pair (per the `live-verify-multimachine` standing rule).

## 5. Rollout: dark → dev → fleet

1. **Additive (dark-safe) merge:** the base-interface methods + `SlackAdapter` implementation + `ConversationRegistry` Slack-inbound wiring land behind the existing Slack adapter's `enabled` flag. With Slack `enabled:false` (fleet default), NONE of it runs — Telegram behavior is byte-identical (the §2.6 fallback resolves Telegram). This satisfies "a bad ship is inert on the fleet."
2. **Dev-agent live-enable:** stand up a live Slack test workspace (§7), set `slack.enabled:true` on the development agent (Echo) only, and drive the Live-User-Channel-Proof harness (§6 Tier 3). Soak.
3. **Fleet:** only after the dev soak passes the §6 acceptance AND a real Mini↔peer Slack swap is live-verified, document the enable path for fleet agents that actually use Slack. Fleet enable is per-agent (an agent with no Slack workspace stays Telegram-only).

## 5a. Migration Parity

Deployed agents update in place; a Slack-parity feature that only works on freshly `init`ed agents is a broken feature (Migration Parity Standard). Coverage:
- **Base-interface methods + `SlackAdapter` implementation** — reach deployed agents AUTOMATICALLY (code shipped in `dist/`). No migration needed (additive optional interface members; no settings/hook change).
- **New config defaults** — `migrateConfig()` adds any new `messaging[].slack.*` fields (system-channel id, the Slack coalescing/flood-guard knobs analogous to Telegram's `attentionTopicGuard`/`topicCreationBudget`) with existence checks (add-missing only), dark-by-default.
- **CLAUDE.md template** — `generateClaudeMd()` gains a "Slack multi-machine parity" awareness section (Agent Awareness Standard): the new base-interface capability, the Slack `/attention` delivery behavior, and — if/when FD-4 ships — the "minted negative Slack conversation ids replicate across machines" note beside the existing WS2 store entries.
- **The FD-4 replication increment (separate ship):** if/when cross-machine mint replication is built, it is a NEW stateSync store `multiMachine.stateSync.conversations` — which per the standard needs (a) the per-store config flag added dark-by-default in `migrateConfig()`, (b) registration as a replicated kind (new `JOURNAL_OPS` replication op + receive-ingest in `ConversationRegistry`), and (c) inclusion in the store enumeration (`PostUpdateMigrator`) + the `stateSyncReceive` map (the current 7 → 8). This is the single largest migration item and is scoped to that increment, not this core parity ship.
- **No hook / `.claude/settings.json` changes** — confirmed: the base-interface additions are code-only.

## 6. Test plan (three tiers + live-verify requirement)

**Tier 1 — Unit** (`tests/unit/slack-adapter-multimachine.test.ts`, `tests/unit/messaging-adapter-mm-contract.test.ts`):
1. **Contract conformance:** `SlackAdapter` implements every optional multi-machine method; a table-driven suite asserts both `TelegramAdapter` and `SlackAdapter` satisfy the same `MessagingAdapter` multi-machine contract (the §2.1 methods present and correctly typed).
2. **Slack attention → system channel, not channel-per-item:** `createAttentionItem` posts a threaded root to the ONE system channel; N low-priority items from one source coalesce into ONE thread; a HIGH/URGENT item always gets its own root (mirrors the Telegram flood-guard invariant).
3. **Minting:** a Slack inbound tuple drives `ConversationRegistry.recordSpeculative` exactly once; a redelivered event does not re-mint; `health().entryCount` increments by 1 with a `platform:'slack'` entry.
4. **Caller dispatch fallback (§2.6):** `resolveAdapterForConversation` returns Telegram for a positive id, the recorded platform for a minted negative id, and the Telegram fallback when the conversation is unbound — proving Slack-off installs are unchanged.
5. **restart-all target resolution (§2.4):** a Slack-bound session with `supportsLifecycleRefresh:true` is INCLUDED; an adapter without the method is skipped exactly as today.
6. **Swap id-space (§2.5):** a minted negative id round-trips through the transfer planner's placement/transfer arg-shaping unchanged.

**Tier 2 — Integration** (`tests/integration/slack-mm-routes.test.ts`): full HTTP pipeline with a Slack adapter wired — `POST /attention` for a Slack conversation delivers via the Slack path (not 503); `POST /sessions/restart-all` includes a Slack-bound session in `scheduled`; `GET /conversations/health` reports `entryCount>0` after a simulated Slack inbound; `POST /pool/transfer {topic:<negId>}` resolves placement for a Slack conversation.

**Tier 3 — E2E lifecycle + LIVE-USER-CHANNEL PROOF (EXO 3.0 — REQUIRED, non-negotiable):**
- Production init path (mirrors `server.ts`) with Slack `enabled:true` returns 200 (not 503) for the Slack attention/lifecycle routes.
- **The operator's explicit requirement:** this feature is NOT done until a **user-role session drives it end-to-end through the REAL Slack surface with real test users**, per the Live-User-Channel-Proof standard (`docs/specs/live-user-channel-proof-standard.md`). The user-role harness (§7) must: send a real Slack message → confirm a durable id is minted → raise a real attention item and see it in the Slack system channel → run restart-all and confirm the Slack session resumes with its conversation intact → **live-verify a topic-swap of a Slack conversation between two real machines** (CONTINUATION lands in Slack, no double-reply, post-transfer closeout fires). Channel-parity: the SAME scenario matrix that passes on Telegram must pass on Slack. A signed PASS/FAIL scenario matrix is the completion artifact; the completion gate refuses "done" without it.
- **Synthetic Slack mocks are insufficient** (memory `live-verify-multimachine`): the multi-machine swap and the minting must be exercised against a real Slack workspace + a real second machine, not a symmetric mock.

**CI ratchet:** a conformance test fails any future adapter added to the registry that claims multi-machine support but does not implement the full contract (Structure > Willpower — "Slack at parity" stays a CI fact).

## 7. Standing up a live Slack test environment (prerequisite)

Slack is `enabled:false`; a live test env is a hard prerequisite for Tier 3. Requirements to resolve before the dev live-enable:
- A dedicated **test Slack workspace** (free tier is sufficient for channels/threads/Block Kit) with a bot token + app-level token (Socket Mode) provisioned. Collect via Secret Drop / vault, never pasted in chat.
- **≥2 real test users** in that workspace (one acting as operator, one as a non-operator) so approved-sender and operator-binding (`SlackPrincipalResolver`) are exercised with authenticated identities — throwaway/demo users, never the live operator channel (Live-User-Channel-Proof volatile-scenario rule).
- A **second machine** in the pool for the swap live-verify (the Mini↔peer pair, per §OQ-3).

## Frontloaded Decisions

Round-2 grep-research (cited against current `main`) resolved five of the six original open questions into decisions; the sixth (OQ-3) genuinely needs the operator and stays below.

- **FD-1 (was OQ-1 — binding granularity):** a Slack conversation binds at **CHANNEL granularity by default**; when an event carries `thread_ts`, it binds at **THREAD granularity** (the mint key `channelId[:threadTs]` already supports both — `conversationIdentity.ts:77-79`). A channel-level message (no thread) is a distinct conversation from its threads. A swap moves the bound unit. Config-overridable per workspace (cheap-to-change; the mint key is unchanged either way).
- **FD-2 (was OQ-2 — swap semantics):** **CONTINUATION is the resume signal** (identical to Telegram). Because Slack has no implicit per-topic "who is serving" affordance, the receiving machine posts NO user-visible marker on a CLEAN swap (avoid noise); an optional subtle "resumed on another machine" ephemeral is emitted ONLY if a reply was in-flight at swap time. Default = CONTINUATION, no marker on a clean swap.
- **FD-3 (was OQ-4 — SessionRefresh Slack resume) — RESOLVED by grep, supersedes §1.3's stale framing:** `SessionRefresh` is **ALREADY Slack-capable** on current main — it has a full Slack arm (`SessionRefresh.ts:146-153, 347-383`: `SlackRefreshBinding`/`SlackRespawner`; the resume re-bind keys on the Slack routing key `<channelId>[:<threadTs>]` via `slackRoutingKeySyntheticId`, NOT a Telegram topic id — `slackRefreshBinding.ts:48-94`). So a Slack-bound session already resumes correctly when the `slack`+`slackRespawner` deps are wired. **restart-all parity is therefore a SMALL EDIT to the `/sessions/restart-all` route's target filter** (which still hard-filters to `ctx.telegram.getTopicForSession` — `routes.ts:7676-7684`; the filter must also consult the Slack binding), NOT a SessionRefresh refactor. (§1.3/§2.4 re-grounded accordingly; the earlier "the resolver is Telegram-topic-shaped" claim was stale.)
- **FD-4 (was OQ-5 — attention pool cross-machine resolution) — RESOLVED by grep + a scope decision:** the mint is durable + content-addressed (deterministic negative ids) but **does NOT replicate across machines today** — `ConversationRegistry`'s `JOURNAL_OPS` has no replication-ingest op, there is no `applyReplicated` method, and `multiMachine.stateSync.conversations` is an unbuilt future increment (referenced only in the `deliverToConversation.ts` heal string, §6.1 step 9). **Honest behavior:** a Slack attention item minted on A appears in B's `?scope=pool` view (id passthrough) but B CANNOT resolve/deliver it to Slack — it is served from the owning machine ("never minted on this machine" heal path). **DECISION:** this spec ships the base-interface parity + `SlackAdapter` + local minting WITHOUT cross-machine mint replication; making the mint replicate is a **NAMED SEPARATE increment** = the 8th stateSync store (`multiMachine.stateSync.conversations`: a new `JOURNAL_OPS` replication op + a receive-ingest path in `ConversationRegistry` + inclusion in the `PostUpdateMigrator` store enumeration + the `stateSyncReceive` map). Until that increment ships, cross-machine Slack attention RESOLUTION is owning-machine-only, documented honestly. This keeps the core parity spec shippable and correctly scopes the replication as a follow-on.
- **FD-5 (was OQ-6 — iMessage/WhatsApp):** the multi-machine methods are **OPTIONAL opt-in members** on `MessagingAdapter` (§2.1, mirroring the Channel-Seamlessness precedent), so a DM-only platform (iMessage/WhatsApp) simply does NOT implement them and is treated exactly as today's non-participant — a NO-OP, never a break. A conformance-test assertion (§6 Tier-1 #1 + the CI ratchet) verifies a non-implementing adapter is SKIPPED, not errored. Slack's channel/thread model bakes in no assumption that blocks a later DM-only parity.

## Open questions

- **OQ-3 (live test workspace + users — OPERATOR-GATED):** the concrete mechanism to stand up a real Slack test workspace with real test users for the EXO 3.0 live-verify — a dedicated free-tier workspace with a bot + 2 human/throwaway users, vs a scripted user-role harness driving the Web API as distinct authenticated users. The Live-User-Channel-Proof standard wants a REAL surface; the cheapest real setup that still exercises authenticated principals needs to be pinned down. **This genuinely needs the operator** (provisioning a real Slack workspace + deciding the test-user mechanism) and is the sole remaining blocker to convergence.
