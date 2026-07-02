---
title: "Durable, Channel-Agnostic Conversation Identity (the Phase-1 structural refactor): Spec"
slug: "durable-conversation-identity"
author: "echo"
status: "draft"
parent-principle: "Structure > Willpower — durable identity must be a registry, not a convention three copies of a hash function remember"
sibling-principles: "The Agent Is Always Reachable — A Guaranteed Reachability Floor; Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions; Know Your Principal — An Unverified Identity Is a Guess; Migration Parity; Close the Loop (Untracked = Abandoned); Bounded Blast Radius"
parent-spec: "docs/roadmaps/instar-two-goal-roadmap-2026-07.md (Phase 1); docs/audits/slack-ai-employee-audit-2026-07.md (§2 root gap, P0-1); docs/audits/mm-current-state-2026-07.md (P1-1)"
depends-on: "SlackAdapter routing keys (src/messaging/slack/SlackAdapter.ts:433-440 resolveRoutingKey — the thread⇄channel identity rules this spec adopts verbatim); the §10.5 conversation-key scheme (src/core/slackRefreshBinding.ts — SLACK_CONVERSATION_KEY_PREFIX + slackRoutingKeySyntheticId, the deployed precedent this spec extends rather than replaces); multi-machine replicated-store foundation (docs/specs/multi-machine-replicated-store-foundation.md — the replication vehicle, WS2 hardening rules reused as-is); the session-pool string sessionKey space (src/core/SessionRouter.ts:55 — deliberately NOT changed); CommitmentTracker + PromiseBeacon (the first proof consumer)"
project: "two-goal-roadmap Phase 1 (topic 29836)"
single-run-completable: false
---

# Durable, Channel-Agnostic Conversation Identity

## 1. Problem

Both program goals converge on one root refactor (roadmap §2, "the single most important
cross-cutting insight"): **instar has no durable, channel-agnostic identity for a
conversation.** Today a conversation is represented three incompatible ways at once:

1. **Telegram: a positive numeric `topicId`** — pervasive and load-bearing. 168 non-test
   source files reference `topicId`; `src/server/routes.ts` alone performs 26
   `Number(...)`/`parseInt(...)` coercions on it; three SQLite schemas pin it as an
   integer column (`pending-relay-store.ts:111` `topic_id INTEGER NOT NULL`,
   `src/memory/TopicMemory.ts:249` + `:288`).
2. **Slack: a transient string routing key** — `resolveRoutingKey(channelId, threadTs,
   ownTs)` → `C…` or `C…:<thread_ts>` (`src/messaging/slack/SlackAdapter.ts:433-440`),
   keyed into the adapter's channel registry (`slack-channel-registry.json`,
   `SlackAdapter.ts:189`) and resume map (`:190`). The session-pool layer discriminates
   purely by shape: `isSlackSessionKey` = "not `/^\d+$/`"
   (`src/core/SlackForwardBridge.ts:24-26`).
3. **The bridge between them: a lossy negative hash, duplicated three times** —
   - `src/commands/server.ts:12194-12203` `slackChannelToSyntheticId` (hashes the bare
     **channelId**; reverse map `slackProxyChannelMap` held in-memory at `:12193`,
     pre-populated only from the channel registry at `:12206-12212`);
   - `src/core/slackRefreshBinding.ts:96-102` `slackRoutingKeySyntheticId` (hashes the
     full **routing key**, thread-aware — its own doc comment flags "the THIRD copy");
   - `src/server/routes.ts:11553-11558` (inline copy in the build-event heartbeat,
     hashes the bare **channelId**).

Because nothing durable can attach to representation (2), every follow-through subsystem
that makes instar an employee on Telegram is structurally dead on Slack: commitments
(`Commitment.topicId?: number`, `src/monitoring/CommitmentTracker.ts:59`), PromiseBeacon
(`PromiseBeacon.ts:1248` → unconditional `POST /telegram/reply/${topicId}`), attention
items (`routes.ts:12323-12327` — 503 without Telegram), reap notices
(`ReapNoticeDrain.ts:179`), cold-start fallback (a Slack spawn failure is a
`console.error`, `src/commands/server.ts:7508-7510` — the "always reachable" floor does
not exist on Slack), the autonomous heartbeat (`server.ts:13108-13119`). And because the
bridge is an unregistered in-memory hash, it is:

- **Lossy / one-way after restart**: a synthetic id whose channel is not in the
  pre-populate set (any thread-level id, any channel first seen mid-process) falls
  through PresenceProxy's Slack branch (`server.ts:12403-12405`) to the Telegram URL →
  `POST /telegram/reply/-N` → guaranteed API failure. A real latent bug, not a
  hypothetical.
- **Collision-unsafe**: a 32-bit truncated hash over short channel-id strings; two
  distinct channels colliding would silently share PresenceProxy state and TopicMemory
  history, and nothing detects it.
- **Internally inconsistent**: the three copies do NOT hash the same input. The
  server.ts and routes.ts copies hash `channelId` (thread-blind); the slackRefreshBinding
  copy hashes `channelId[:thread_ts]` — so one thread conversation already yields two
  different synthetic ids depending on the code path.

On the Goal-2 side, the numeric assumption gates mesh machinery: the working-set carrier
fires only on `Number.isFinite(Number(cmd.session))` (`server.ts:18213-18219`), the
topic-profile acquire seam rides the same gate (`:18219`), and
`WorkingSetPullCoordinator.onTopicAccepted(topic: number)`
(`src/core/WorkingSetPullCoordinator.ts:117`) — a moved Slack conversation silently
loses its working set and profile carry.

**The fix must be durable (survives restarts), registry-backed (collisions detected, ids
resolvable both directions), channel-agnostic (Slack now; WhatsApp/iMessage later), and
incremental (168 files cannot flip in one PR).**

## 2. Design decision — minted numeric id behind a registry, NOT a typed-union big-bang

The roadmap allows either "registry-backed conversation key ⇄ minted stable numeric id"
or "a typed-union refactor of `topicId`". The code evidence decides it:

**Chosen: a `ConversationRegistry` that mints a stable NEGATIVE numeric id per
non-Telegram conversation, with the string conversation key as the canonical identity
stored in the registry.** Consumers keep their `number`-typed `topicId` fields verbatim.

Why the evidence forces this choice:

1. **The blast radius of a union refactor is the whole system.** 168 files type or
   consume `topicId` as a number; three SQLite schemas pin INTEGER columns; JSON stores
   persist numbers. A `topicId: number | string` union ripples through
   PromiseBeacon/ResumeQueue/JobDefinition/attention/relay-store signatures AND creates a
   fleet-skew nightmare: an old server reading a string `topicId` out of
   `state/commitments.json` mid-upgrade breaks on every `parseInt`/arithmetic path.
   Zero-data-loss during a skew window is a hard requirement; the union cannot deliver it
   incrementally.
2. **The negative-id convention is already deployed and load-bearing.** Negative
   synthetic ids flow today through PresenceProxy, standby/triage commands
   (`server.ts:9831-9883`), suppression matching (`:12355-12357`), and are DURABLY
   persisted in TopicMemory (`topic_id INTEGER`, negative rows written by the dual-write
   at `server.ts:13216-13227`). The concept is proven; what is broken is that it is
   unregistered, in-memory, triplicated, and collision-blind. A registry fixes exactly
   those four defects while keeping every consumer type-stable.
3. **The newer stores already tolerate the union — so we lose nothing.** TopicProfileStore
   (`get(topicKey: number | string)`, `src/core/TopicProfileStore.ts:241-274`),
   TopicProfileResolver (`:109`), TopicOperatorStore (`setOperator(topicId: number |
   string)`, `src/users/TopicOperatorStore.ts:105`), `dedupeKeyFor(platform, topicId:
   number | string, …)` (`src/messaging/ingressDedup.ts:32`), AutonomousSessions
   (`topic: string | null`, `activeAutonomousRunFor(topic: string | number)`,
   `src/core/AutonomousSessions.ts:24,108-111`), and the pin store
   (`Record<string, TopicPin>`, `src/core/TopicPlacementPinStore.ts:67`) all key on
   `String(topicKey)`. A minted numeric id passes through all of them unchanged today.
   The registry's canonical string key remains available for any future consumer that
   wants it — the union arrives lazily, per store, with no flag-day.
4. **The session-pool layer needs NO change.** `SessionRouter.sessionKey` is already an
   opaque string (`src/core/SessionRouter.ts:55`), `POST /pool/transfer` already reads
   `topic` as a string (`routes.ts:13995`), and workspace-aware placement exists
   (`src/core/machineServesChannel.ts:27-64`). The registry sits BESIDE the transport
   key space as a join table, not a replacement of it.

**One conversation, two representations, one registry as the join point:**

```
canonical key (string)            minted id (number)         transport sessionKey (string)
slack:T0BA1DR0U3D:C0BA4F4E0FP  ⇄  -83921477              ⇄  C0BA4F4E0FP
slack:T0BA1DR0U3D:C0BA4F4E0FP:1751412345.123456
                               ⇄  -1192337014            ⇄  C0BA4F4E0FP:1751412345.123456
(telegram topics)  12476        =  12476 (pass-through)   =  "12476"
```

Telegram topics are NEVER registered: a positive id IS its own identity, verbatim,
forever (back-compat by construction). The registry is sparse — it holds only minted
(non-Telegram) conversations. `resolve(id)`: `id > 0` → Telegram pass-through;
`id < 0` → registry lookup.

## 3. The identity registry

### 3.1 Canonical key format

Extends the DEPLOYED §10.5 scheme (`slackRefreshBinding.ts:69-79` —
`slack:<channel>[:<thread>]`) with a workspace segment, per the roadmap:

```
slack:<teamId>:<channelId>              — channel-level conversation
slack:<teamId>:<channelId>:<threadTs>   — thread-level conversation
telegram: (never stored — positive ids pass through)
(reserved prefixes: whatsapp:, imessage:, …  — same mint rules, out of scope here)
```

- `<teamId>` comes from `SlackAdapter.getWorkspaceId()` (`SlackAdapter.ts:386`, config-
  sourced). When it is genuinely unknown (older config), the placeholder `_` is used AND
  the registry additionally enforces uniqueness on the structured tuple
  `(platform, channelId, threadTs)` — so a later teamId backfill upgrades the key IN
  PLACE (same id, key metadata rewritten, journaled). **The id never changes; the key
  string is mint-time identity plus upgradable metadata.** This keeps single-workspace
  reality working today and multi-workspace (roadmap Phase 7.1) additive.
- The `<channelId>[:<threadTs>]` tail IS the adapter routing key — conversion between
  canonical key and transport sessionKey is a pure string operation
  (`parseSlackRoutingKey`, `SlackForwardBridge.ts:31-38`, reused).

### 3.2 Slack thread ⇄ conversation mapping rules (adopted verbatim from resolveRoutingKey)

The conversation of record for a message is its **resolved routing key**
(`SlackAdapter.ts:433-440`) — this spec introduces NO new thread semantics:

| Case | Conversation |
|---|---|
| Plain channel message | `slack:<team>:<channel>` |
| DM / group DM | `slack:<team>:<D…/G… channel id>` — a DM is just a channel whose id starts with `D`/`G`; no special identity |
| Thread reply, thread routing enabled for the channel | `slack:<team>:<channel>:<thread_ts>` |
| Thread reply, thread routing DISABLED (live default) | `slack:<team>:<channel>` (collapses to the channel conversation) |
| Thread ROOT (thread_ts === own ts) | `slack:<team>:<channel>` (a root is a channel message until someone replies) |
| A NEW thread started on an OLD message | `slack:<team>:<channel>:<thread_ts>` where `thread_ts` is the old message's ts — a **new conversation, minted at first reply**, stable forever after (the root's ts is immutable) |

Consequence spelled out: flipping a channel's `threadSessions` opt-in mid-life changes
which conversation FUTURE thread replies land in (channel-level ↔ thread-level). That is
today's live behavior for sessions and is accepted for identity too; commitments already
attached keep their original conversation id and still deliver there (the id resolves
independently of the current routing mode).

### 3.3 Mint rule — deterministic candidate + registry-checked probe

```
candidate(routingKey) = -(Math.abs(h) + 1)   where h = the deployed 32-bit sum-shift hash
                                             over the ROUTING KEY (thread-aware — the
                                             slackRoutingKeySyntheticId semantics)
mint(key):
  existing = registry.byKey(key)             → return existing.id          (idempotent)
  id = candidate(routingKey(key))
  while registry.byId(id) exists for a DIFFERENT key:  id -= 1             (probe down)
  persist { key, id, … } durably (atomic write), THEN return id
```

Why the legacy hash is the candidate — three load-bearing properties:

1. **Zero-loss adoption.** Every synthetic id already durably written (TopicMemory
   message + summary rows; any PresenceProxy state) was computed by this hash over the
   channelId. A channel-level conversation's first mint lands on the SAME id the legacy
   code produced — existing history attaches to the registered conversation instead of
   orphaning. (Thread-level ids match the slackRefreshBinding copy's semantics — the
   only copy that was thread-aware.)
2. **Mixed-fleet convergence with zero coordination.** During a version-skew window, an
   old server computes the hash directly; a new server mints via the registry with the
   hash as candidate. Same key → same id on both, without any cross-version protocol.
   The ONLY divergence window is a probe (a real 32-bit collision between two distinct
   keys) — which the registry detects, records, and surfaces (see §3.5); the legacy code
   would have silently corrupted state in that same case.
3. **Deterministic re-mint under registry loss.** A rebuilt registry re-mints the same
   ids for the same keys (absent probes), so even catastrophic registry loss degrades to
   "aliases may be needed", never "all ids changed".

Collision safety with real Telegram topic ids is **structural**: minted ids are always
`< 0`; Telegram `message_thread_id` values are always `> 0`. The registry validates
`id < 0` on every write and every replicated ingest (type-clamp). `0` is unmintable
(`-(abs+1)` ≥ 1 in magnitude).

### 3.4 Storage

`state/conversation-registry.json` — house-style JSON store: atomic tmp→rename writes,
single-writer serialized `mutate()` (the CommitmentTracker/TopicProfileStore CAS
pattern), in-memory cache authoritative for reads, corrupt-file quarantine-aside with the
one deduped attention item (the TopicPlacementPinStore pattern,
`TopicPlacementPinStore.ts:55-60`). Entry shape:

```jsonc
{
  "version": 1,
  "conversations": {
    "slack:T0BA1DR0U3D:C0BA4F4E0FP": {
      "id": -83921477,
      "platform": "slack",
      "workspaceId": "T0BA1DR0U3D",
      "channelId": "C0BA4F4E0FP",
      "threadTs": null,
      "mintedAt": "2026-07-02T21:00:00.000Z",
      "mintedBy": "<machineId>",
      "origin": "adopted-legacy-hash" | "minted-probed" | "replicated",
      "hlc": { "physical": 0, "logical": 0, "node": "…" },
      "label": "#engineering"            // display-only, refreshable, never identity
    }
  },
  "aliases": { "-83921478": -83921477 }  // divergence repairs only — see §3.5
}
```

Growth is bounded by real usage (one entry per conversation ever spoken in; a busy org
is thousands of entries — trivially fine for a JSON store; compaction is a non-problem
and deliberately out of scope). The file joins `config.backup.includeFiles` via
PostUpdateMigrator exactly as `state/topic-profiles.json` + `state/topic-operators.json`
did (`PostUpdateMigrator.ts:8905-8944` — durable identity class; stateDir-RELATIVE path
shape per the pinned round-6 lesson).

### 3.5 Multi-machine replication semantics

**Mint authority: the machine that owns/serves the conversation.** Inbound dispatch on
the owner is the minting site (with the pool live, ownership is CAS-claimed per
sessionKey; with the pool dark, only one machine has Slack enabled — today's live
deployment). This makes same-key concurrent mints structurally rare; the deterministic
candidate makes even a genuine race CONVERGENT (both machines compute the same id from
the same key unless one of them had a prior probe).

**Replication rides the replicated-store foundation** as a new store,
`multiMachine.stateSync.conversations` (ships dark: `enabled:false`, `dryRun:true` —
the standard graduated ladder; single-machine agents are a strict no-op). Reused WS2
hardening, applied to this store:

- **Type-clamp on ingest**: `id` must be a negative safe integer; `key` must match
  `^[a-z]+:[A-Za-z0-9_.:-]+$`; timestamps ISO-8601-only; `label` length-bounded. A
  replicated entry is routing metadata, never an instruction.
- **Cross-machine identity = the canonical key** (content fingerprint), never a local
  ordinal.
- **No-clobber**: a replicated entry NEVER rebinds an existing local key→id pair.
- **Same key, different id** (the only true divergence — requires a probe on one side):
  deterministic winner = the entry with the LOWER HLC (tiebreak: lexicographically
  smaller machineId); the loser id is recorded in `aliases` resolving to the winner.
  Both machines apply the same rule → convergence. Consumer data already written under
  the alias id keeps working: `resolve(aliasId)` returns the winning conversation
  (aliases are followed exactly one hop; the registry forbids alias chains by resolving
  at write time). ONE deduped attention item surfaces the episode (expected frequency:
  ~never — it requires a 32-bit collision AND a partition).
- **Same id, different key** (a forged or corrupt entry trying to seize an existing id):
  REFUSED on ingest, quarantined-aside, one deduped attention item. Never applied.
- **Tombstones**: none. Conversations are never deleted (an id that ever entered a
  durable store must resolve forever). Registry entries are append-only plus in-place
  metadata upgrades (§3.1 teamId backfill, label refresh).

### 3.6 Failure modes (decided)

| Failure | Behavior |
|---|---|
| Registry unavailable/corrupt at inbound time | **Fail toward delivery** (the message is never blocked on identity): compute `candidate(routingKey)` in-memory — byte-identical to today's legacy behavior — proceed, and journal a pending-mint that heals into the store on recovery. Corrupt file → quarantine-aside + rebuild via the adoption pass (§6.2); healed ids equal the in-memory ones by determinism. |
| Two machines mint the same key concurrently | Same candidate → same id → replication merges silently. Probe divergence → §3.5 alias rule, deterministic on both sides. |
| A peer replicates garbage | Type-clamp + no-clobber + seize-refusal (§3.5). Fails closed on the registry write, never on message delivery. |
| Mint requested for an unparseable/foreign key | Refused (typed error). Callers treat it as "no durable id" and keep legacy behavior for that message. |

## 4. Retiring the three hash copies (foundation increment)

One new module, `src/core/conversationIdentity.ts`, absorbs `slackRefreshBinding`'s key
helpers and exports the SINGLE hash + mint surface. The three copies become delegates:

| Today | Becomes |
|---|---|
| `server.ts:12194` `slackChannelToSyntheticId(channelId)` + `slackProxyChannelMap` | `registry.mintForRoutingKey(channelId)`; the in-memory reverse map is replaced by `registry.resolve(id)` (with the process-local cache the store already keeps). The pre-populate loop (`:12206-12212`) becomes the §6.2 adoption pass. |
| `routes.ts:11553-11558` inline hash (build heartbeat) | `ctx.conversationRegistry.mintForRoutingKey(channelId)` (ctx-injected like every other store). |
| `slackRefreshBinding.ts:96` `slackRoutingKeySyntheticId(routingKey)` | Re-exported FROM `conversationIdentity.ts` as the candidate function (`candidateIdForRoutingKey`) — it is the mint candidate, no longer an identity authority. SessionRefresh's `RefreshResult.topicId` now carries the MINTED id (identical value in every non-probed case). |

This increment is **behavior-identical by construction** for every existing conversation
(same ids, now durable + resolvable + collision-checked) and fixes the PresenceProxy
restart hazard (§1) as a side effect: `resolve(id)` works for thread-level and
late-seen channels because the mint persisted them.

The negative-id sniffing scattered through server.ts (`topicId < 0` at `:9880`,
`:12357`, the PresenceProxy branch `:12403`) collapses onto `registry.resolve(id)`
returning a typed channel descriptor — `{ platform:'slack', channelId, threadTs? }` —
instead of consulting the in-memory map.

## 5. The outbound funnel — `deliverToConversation`

A single delivery helper (server-bootstrap-wired, ctx-exposed) that every
follow-through consumer migrates onto:

```
deliverToConversation(id: number, text, opts):
  id > 0  → today's Telegram path (POST /telegram/reply/:id — queue, dedup,
            idempotency, tone gate: all existing layers, unchanged)
  id < 0  → registry.resolve(id) → POST /slack/reply/:channelId with thread_ts
            (the route ALREADY accepts thread_ts and runs the tone gate —
            routes.ts:12163-12186; thread-level conversations finally deliver
            IN-THREAD instead of the channel-blind sendToChannel the synthetic
            bridge used)
  unresolvable negative id → typed failure (never a silent drop; the caller's
            existing failure path — beacon retry, attention escalation — engages)
```

Hardening that ships with it: `POST /telegram/reply/:topicId` gains a 400 on
`topicId <= 0` ("negative = minted conversation — use the conversation funnel"),
turning today's silent Telegram-API 500 for leaked synthetic ids into a typed,
diagnosable refusal.

Explicitly NOT in this funnel (non-goals, Phase 2.1): a Slack PendingRelayStore lane,
DeliveryFailureSentinel `channel:'slack'`, delivery-id idempotency for Slack, the
GFM→mrkdwn formatter. The funnel delivers through the EXISTING `/slack/reply` with
exactly its current robustness (tone gate only). Robustness parity is the next roadmap
item and slots in UNDER this funnel without changing its callers.

## 6. Consumer migration — order, shims, and what each needs

### 6.0 Inventory (verified against JKHeadley/main v1.3.722)

| # | Consumer | Numeric coupling (file:line) | What it needs from a durable id |
|---|---|---|---|
| 1 | Commitments | `Commitment.topicId?: number` (`CommitmentTracker.ts:59`); beacon requires topicId (`routes.ts:21811-21815`) | An id that is a number, stable across restarts, deliverable both platforms. Minted id satisfies all three; the route's truthy check accepts negatives (test pinned). |
| 2 | PromiseBeacon | `sendMessage(c.topicId…)` → `/telegram/reply/${topicId}` (`PromiseBeacon.ts:1248`; wiring `server.ts:~13000`) | Swap the injected `sendMessage` to `deliverToConversation`. Beacon logic untouched. |
| 3 | Attention queue | `AttentionItem.topicId?: number` (`TelegramAdapter.ts:273`); 503 without Telegram (`routes.ts:12323-12327`); topic-spawning is TelegramAdapter-internal | Accept items on minted ids; deliver via funnel into the conversation (Slack per-conversation surface = Phase 2.3; until then Slack items ride the existing attention-channel mirror). |
| 4 | Reap notices + PendingRelayStore | `topic_id INTEGER NOT NULL` (`pending-relay-store.ts:111`); drain sends via `sendToTopic(row.topic_id…)` (`ReapNoticeDrain.ts:179`) | NO schema change — a minted id IS an integer. Only the drain's send resolves via the funnel. |
| 5 | DeliveryFailureSentinel | hardcodes `channel:'telegram'` (`delivery-failure-sentinel.ts:440`) | Phase 2.1 (non-goal here); the funnel gives it the resolve primitive. |
| 6 | Cold-start fallback | builder consumed by Telegram `sendToTopic` (`server.ts:2389, 2452`); Slack spawn failure = `console.error` (`server.ts:7508-7510`) | Mint at Slack inbound (§6.3) + funnel → the reachability floor finally exists on Slack. |
| 7 | AutonomousProgressHeartbeat | unconditional `/telegram/reply` (`server.ts:13108-13119`) | Funnel swap of the injected sendMessage. |
| 8 | Autonomous runs | `<stateDir>/autonomous/<topic>.local.md`, already `topic: string \| number` tolerant (`AutonomousSessions.ts:5,24,108-111`) | Nothing structural — minted ids stringify fine. |
| 9 | Topic-operator | store union-ready (`TopicOperatorStore.ts:39,105`); route coerces `Number()` (`routes.ts:6053`); auto-binds are Telegram-gated (`server.ts:2051`, `routes.ts:17253-17256` — `typeof topicId === 'number'`) | Route accepts minted ids as-is (they ARE numbers). Slack KYP auto-bind = roadmap Phase 3.1, keyed on the minted id this spec provides. |
| 10 | Topic-bindings | `Number(topicId)` (`routes.ts:5988`); `CoherenceGate` `topicId?: number` (`CoherenceGate.ts:49`) | Minted ids pass unchanged. |
| 11 | Topic-profiles | store + resolver union-ready (`TopicProfileStore.ts:241-274`, `TopicProfileResolver.ts:109`) | Minted ids pass unchanged; the §10.5 Slack refresh arm now shares ids with everything else. |
| 12 | Working-set carrier / profile acquire seam | `Number(cmd.session)` + `Number.isFinite` gates (`server.ts:18213-18219`); `onTopicAccepted(topic: number)` (`WorkingSetPullCoordinator.ts:117`) | At the onAccepted seam: non-numeric sessionKey → `registry.idForSessionKey(key)` → fire the carrier with the minted id. Slack conversations gain working-set + profile carry on transfer. |
| 13 | Pool transfer/placement | already string-typed `topic` (`routes.ts:13995`, `:13858-13864`) | Nothing — transport keys stay strings; the registry answers "which numeric id is this transport key" when a consumer needs it. |
| 14 | Escalation (models tier) | `EscalationHintStore` `Record<string, EscalationHint>` (string-keyed, union-tolerant) | Nothing structural; hints file under `String(mintedId)` like any topic. |
| 15 | Resume queue | `topicId?: number` (`ResumeQueue.ts:65,187`) | Minted ids pass unchanged. |
| 16 | Message stores / TopicMemory | `topic_id INTEGER` (`TopicMemory.ts:249,288`); dual-write already uses the hash (`server.ts:13216-13227`) | NO schema change; adoption (§3.3) preserves every existing negative row's attachment. Dual-write swaps hash→mint (same values). |
| 17 | PresenceProxy / standby | synthetic ids + in-memory map (`server.ts:12193, 12402-12430`) | Foundation increment (§4). Fixes the restart fall-through bug. |
| 18 | Session↔topic maps | Slack: `slack-channel-registry.json` / resume map keyed on routing keys (`SlackAdapter.ts:189-190`) | UNCHANGED — transport-layer keys deliberately stay routing keys (§2 point 4). |
| 19 | Ingress exactly-once ledger | schema already generic (`platform TEXT`, `topic TEXT`, `MessageProcessingLedger.ts:75`); callsite hardcodes telegram (`routes.ts:17178-17192`); Slack has only in-memory `seenMessageTs` (`SlackAdapter.ts:963-970`) | Phase 2.2 (non-goal); `dedupeKeyFor` already accepts string topics — the ledger will key on the canonical key. |
| 20 | Jobs / decision journal / privacy scopes | `JobDefinition.topicId?: number` (`types.ts:393`), `DecisionJournalEntry` (`:1639`), privacy/onboarding/export (`:6455-6508`) | Minted ids pass unchanged (numbers). No work. |

### 6.1 Migration order (each increment independently shippable + live-provable)

1. **Foundation** (§3 + §4 + §5): registry, hash consolidation, resolve routes,
   `deliverToConversation`. Behavior-identical; ships live.
2. **Commitments + PromiseBeacon — THE proof consumer** (roadmap Phase-1 live proof):
   Slack inbound mints eagerly (§6.3); the session's commitment carries the minted id;
   beacon heartbeats deliver through the funnel into the exact thread.
   *Live proof:* create a commitment from a Slack THREAD, restart the server, watch the
   beacon heartbeat land back in that thread (in-thread, not channel-blind).
3. **Cold-start fallback**: Slack spawn failure answers in-channel through the funnel
   (kills the `console.error` hole; extends "The Agent Is Always Reachable" to Slack).
4. **AutonomousProgressHeartbeat** funnel swap.
5. **Attention items**: accept + deliver on minted ids (per-conversation Slack ack UX
   stays Phase 2.3).
6. **Reap notices / PendingRelay drain** funnel swap (schema untouched).
7. **Working-set / profile-carry seam** (§6.0 #12): minted-id resolution at
   `onAccepted` — Slack conversations join Goal-2 transfer machinery.
8. **Route-surface cleanups**: the 26 `Number()` coercions audited; any
   `> 0`-style guards (`routes.ts:24915` is the only one found — Telegram-scoped by
   design, left alone) pinned by tests.

Compatibility shim during the window: consumers not yet migrated simply keep doing what
they do today — nothing about the registry's existence changes their behavior, because
ids are value-identical to the legacy hash. There is no dual-write phase and no
translation layer to retire later; the "shim" is the determinism of the mint rule.

### 6.2 Adoption pass (PostUpdateMigrator + boot)

Idempotent, boot-time ensure (not a one-shot migration): for every channel in
`slack-channel-registry.json` (`SlackAdapter.ts:189`), `mint(slack:<team>:<channel>)`.
This pre-registers all known conversations with their legacy-hash ids before any
consumer asks, exactly replacing the old pre-populate loop (`server.ts:12206-12212`).
PostUpdateMigrator additions: (a) `state/conversation-registry.json` into
`config.backup.includeFiles` (idempotent set-union, stateDir-relative); (b) nothing
else — no store rewrites anywhere, by design.

### 6.3 Eager mint at Slack inbound + session surface

The Slack inbound dispatch (`server.ts:7317-7511`) mints (get-or-create) the
conversation id for the resolved routing key on EVERY inbound — one cached registry read
after the first. The minted id is carried in the session bootstrap context and message
metadata so the session can attach durable state to it (`POST /commitments` with
`topicId = <minted id>`). Exact prompt/metadata wording is build-time
(cheap-to-change); the requirement is: **a Slack-bound session must be able to learn its
conversation id without guessing.** The dispatch's binding gap named in the audit
("creates no binding, commitment, or profile" — `server.ts:7317-7511`) closes to
"creates the identity everything else can bind to."

## 7. Security — the id is routing identity, never authority

- **Know Your Principal is untouched.** Operator binding still happens ONLY through
  authenticated-sender writes (`TopicOperatorStore.setOperator` from authorized inbound —
  `server.ts:2051`, `routes.ts:17253-17262`); profiles stay verified-operator/PIN-gated.
  A conversation id names WHERE a conversation is, never WHO commands it. Nothing in
  this spec adds an authority path keyed on the id.
- **A peer cannot forge or collide an id to steal bindings** (the named threat):
  - Rebinding an existing key→id: refused (no-clobber, §3.5).
  - Seizing an existing id under a new key: refused + quarantined (§3.5).
  - Minting a positive id (colliding with a real Telegram topic): structurally
    impossible (`id < 0` clamp on every write and ingest).
  - Same-key alias resolution changes which id is canonical but both ids resolve to the
    SAME conversation — there is no cross-conversation capture path.
  - Bindings themselves (operator, profiles) replicate under their OWN stores' rules
    (WS2.3/WS2.6: replicated records are advisory, local-authoritative for resolution) —
    a forged registry entry carries no binding payload at all.
- **At-rest honesty** (same posture as `slack-channel-registry.json` and the
  relationships store): the registry is plaintext machine-local; it reveals WHICH
  channels/threads the agent talks in (ids + labels), never message content, tokens, or
  principals.
- **Registry writes are Bearer-gated** like every store route; there is no unauthenticated
  mint surface (inbound dispatch mints server-side from authenticated adapter events).

## 8. Observability

Registry-first reads (the operator asks "what conversation is this id?" — read it, never
guess):

- `GET /conversations` — inventory (`?platform=slack`, `?limit=`), entries as §3.4 plus
  the alias table.
- `GET /conversations/:id` — resolve one id: minted → the full entry (+ `aliasOf` when
  applicable); positive → `{ platform:'telegram', topicId, passThrough:true }`; unknown
  negative → 404 with the honest "never minted on this machine" body.
- `GET /conversations/resolve?key=…` (or `?sessionKey=…`) — forward lookup, mints
  NOTHING (read-only; `?mint=1` is deliberately not offered — mint stays at the owning
  inbound/funnel chokepoints).
- `GET /conversations/health` — counts by platform/origin, alias count, adoption-pass
  state, last mint, quarantine state. The e2e "feature is alive" target.
- Every mint/adopt/alias/refusal appends one line to `logs/conversation-registry.jsonl`
  (append-only audit; ids and keys only, never content).

## 9. Config, rollout, migration parity

```jsonc
"conversationIdentity": {
  // Foundation (registry + consolidation + resolve routes): ALWAYS ON once shipped —
  // it is behavior-identical recording of ids already in use (the reap-log posture).
  // There is deliberately NO off-switch for recording; the rollback lever below
  // reverts the DELIVERY behavior, not the bookkeeping.
  "followThrough": {
    "enabled": false,       // dev-gate resolved (omitted ⇒ live-on-dev, dark-fleet)
    "dryRun": true          // funnel LOGS would-deliver for minted ids, delivers nothing
  }
},
"multiMachine": { "stateSync": { "conversations": { "enabled": false, "dryRun": true } } }
```

- **Foundation ships live** (§4 is a refactor: same ids, one copy, now durable). Its
  safety net is determinism + the golden parity tests (§10).
- **`followThrough` rides the graduated ladder**: dark on the fleet, live-in-dryRun on
  the dev agent (would-deliver lines audited), flipped `dryRun:false` on dev only for
  the live proof, fleet-flip only after the Phase-2 soak. While dark/dry, minted-id
  deliveries LOG and the legacy behavior (beacon → `/telegram/reply` failing on
  negatives) is replaced by a typed no-op — strictly less wrong than today.
- **Replication ships dark** like every WS2 store; single-machine no-op.
- **Migration parity** (the standard's checklist): config defaults →
  `migrateConfig()` existence-checked; backup manifest → §6.2; no hook/template/skill
  changes; no CLAUDE.md template change needed beyond the Capabilities entry for
  `GET /conversations*` (Agent Awareness Standard — added with the foundation PR).
- **Rollback**: `followThrough.enabled:false` reverts all delivery behavior;
  the registry file is inert data under rollback (old code never reads it). The
  foundation's hash consolidation is rollback-by-revert (pure refactor, no data
  format at risk).

### Fleet-skew window (both directions, explicitly)

- **Old server + new store**: old code never opens `conversation-registry.json`; it
  computes hash ids directly — value-identical. No interference, zero data loss.
- **New server + old stores**: adoption pass fills the registry from existing state;
  every consumer store (commitments, relay rows, TopicMemory) is read UNCHANGED — there
  is no store version bump anywhere in this spec.
- **Mixed-fleet minting**: §3.3 property 2. The one divergent case (probe) is exactly
  the case that silently corrupts TODAY; post-refactor it is detected + aliased +
  surfaced.

## 10. Tests (Testing Integrity Standard — three tiers + wiring + alive)

**Tier 1 — unit** (`tests/unit/conversation-registry.test.ts` + funnel unit):
- Mint idempotency (same key → same id, across process restarts via re-open).
- **Golden parity**: `candidateIdForRoutingKey` reproduces the EXACT ids of all three
  legacy copies for channel-level keys, and of slackRefreshBinding for thread keys
  (fixture table of real-shaped ids — the zero-loss adoption guarantee as code).
- Probe: seeded collision → next-lower id; both orderings converge post-merge (alias
  rule determinism, both machines' perspectives).
- Ingest clamps: positive id refused; malformed key refused; rebind refused; seize
  refused + quarantined; alias one-hop-only invariant.
- resolveRoutingKey mapping table (§3.2) — every row, both directions.
- Corrupt file → quarantine-aside → rebuilt ids equal pre-corruption ids.
- Funnel semantics: `id>0` → telegram path; `id<0` resolved → slack path with
  thread_ts; unresolvable → typed failure; dryRun → would-deliver log, no send.
- Beacon-visible behavior: a commitment with a negative topicId passes the route's
  validation (the truthy-check pin) and beacon delivery routes via the funnel.

**Tier 2 — integration** (full HTTP pipeline):
- `GET /conversations*` routes: list/resolve/health, 404 semantics, Bearer auth.
- `POST /commitments` with a minted id → beacon tick → funnel → mocked Slack adapter
  receives channel + thread_ts.
- `/telegram/reply/:topicId` 400-on-negative.
- Inbound dispatch mint: synthetic Slack inbound → registry entry exists, session
  metadata carries the id, second message mints nothing new.

**Tier 3 — e2e "feature is alive"** (mirrors server.ts production init): boot the real
server wiring, assert `GET /conversations/health` answers **200, not 503**, adoption
pass ran (channel registry fixture pre-registered), and a full
inbound→mint→commitment→restart→beacon→delivery cycle completes against the fixture
adapter. This is the single most important test in the spec.

**Wiring integrity**: ctx.conversationRegistry non-null in the production init path; the
three former hash callsites delegate to the ONE export (a grep-ratchet lint — the hash
literal `(hash << 5) - hash` may appear in exactly one src file — makes a fourth copy a
CI failure, per Structure > Willpower).

**Semantic boundary tests**: id>0/id<0 resolution both sides; thread vs channel key both
directions; adopted-legacy vs minted-probed vs replicated origins; dryRun on/off.

**Live proof script** (the roadmap clause, run test-as-self on the dev agent against the
Slack live-test workspace): post in a thread in #engineering → agent commits "I'll
report back in 10 minutes" (commitment visible in `GET /commitments` with the minted
id) → `instar` server restarted → beacon heartbeat arrives IN THAT THREAD → commitment
delivered/closed. Recorded per the Live-User-Channel-Proof scenario-matrix standard.

## 11. Non-goals (blast radius kept honest)

1. **Slack outbound robustness** — queue/retry/dedup/idempotency/formatter/
   DeliveryFailureSentinel lane (roadmap Phase 2.1). The funnel delivers with exactly
   `/slack/reply`'s current guarantees.
2. **SlackLifeline instantiation** (Phase 2.2) and **socket-follows-lease / Slack
   exactly-once ingress ledger** (Phase 2.2) — the registry provides the key they will
   use; they are not built here.
3. **KYP on Slack** (operator auto-bind from authenticated Slack senders — Phase 3.1).
   This spec provides the id the binding will attach to; it does not create bindings.
4. **Permission-gate enforce, responseReview, attention in-Slack ack UX,
   message_changed/reaction handling, multi-workspace adapters, thread-sessions default**
   — Phases 0/2/7 items, untouched.
5. **Re-keying the session-pool transport layer** — sessionKeys stay routing-key strings
   (§2 point 4); ownership journals, resume maps, and the forward bridge are unchanged.
6. **Renaming `topicId`** across the codebase — churn without value; the field name
   stays, its VALUE domain now includes minted ids.
7. **WhatsApp/iMessage minting** — the key space reserves the prefixes; wiring their
   adapters through the registry is future per-channel work.
8. **Registry compaction/GC** — bounded-by-usage; deliberately never deletes.

## Frontloaded decisions

1. **Minted numeric id over typed-union** — §2, evidence-forced (168 files, 3 SQLite
   INTEGER schemas, deployed negative-id convention, zero-loss skew requirement).
2. **Legacy hash as deterministic mint candidate** — §3.3 (zero-loss adoption +
   coordination-free mixed-fleet convergence + rebuildability).
3. **Thread identity = resolveRoutingKey verbatim** — §3.2 (no new semantics; a new
   thread on an old message is a new conversation at first reply).
4. **Canonical key carries workspace with `_` placeholder + in-place upgrade** — §3.1
   (id never changes; key metadata upgradable).
5. **Mint on the owning machine; replicate as a dark WS2 store; alias (never rewrite) on
   divergence; conversations are never deleted** — §3.5.
6. **Fail toward delivery on every registry failure** — §3.6 (identity must never cost a
   message).
7. **Foundation ships live (behavior-identical); delivery changes ride the dev-gate +
   dryRun ladder** — §9.
8. **Commitments + PromiseBeacon are the first proof consumer; order fixed** — §6.1.
9. **Transport sessionKeys unchanged; registry is a join table, not a re-keying** — §2/§6.
10. **`/telegram/reply` refuses negative ids (400)** — §5 (typed refusal replaces a
    silent downstream 500).

## Open questions

1. **Attention-item per-conversation ack UX on Slack** (reaction? interaction button?) —
   deferred to Phase 2.3's spec; this spec only makes the item addressable. (Tracked,
   not blocking: items on minted ids deliver via the funnel meanwhile.)
2. **Whether Phase 2.2's Slack exactly-once ledger keys on the canonical key or
   `(channel, ts)`** — that spec's call; `dedupeKeyFor` already accepts string topics
   either way. Nothing here constrains it.
