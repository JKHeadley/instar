---
title: "Durable, Channel-Agnostic Conversation Identity (the Phase-1 structural refactor): Spec"
slug: "durable-conversation-identity"
author: "echo"
status: "draft"
parent-principle: "Structure beats Willpower — durable identity must be a registry, not a convention three copies of a hash function remember"
sibling-principles: "The Agent Is Always Reachable — A Guaranteed Reachability Floor; Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions; Know Your Principal — An Unverified Identity Is a Guess; A Refusal Stays a Refusal; Bounded Notification Surface (P17); Migration Parity; Close the Loop (Untracked = Abandoned); Bounded Blast Radius"
lessons-engaged: "Structure beats Willpower (one registry, not three hashes) · Maturation Path — Every Feature Ships Enabled on Developer Agents (§9 dev-gated ladder) · The Agent Is Always Reachable, corollary 2 (§5 deterministic reachability arm) · A Refusal Stays a Refusal / P18 (§5 dryRun returns typed non-delivery, never success-shaped) · Bounded Notification Surface P17 (§5 funnel per-conversation budget + burst test) · Bounded Blast Radius (§3.3 mint-rate breaker) · Cross-Machine Coherence (§3.5 local-origin adoption; §5 owning-machine delivery) · Know Your Principal (§7 replicated entry is advisory, never delivery authority) · Migration Parity (§9 migrateConfig never materializes enabled:false; migrateClaudeMd) · Deferral = Deletion / Close the Loop (§11 Phase-2.1 tracked) · P7 LLM-Supervised Execution (§6.2 Tier 0 justified) · P14 Distrust Temporary Success (§3.3 birthday math honest; §6.2 journal-replay rebuild)"
parent-spec: "docs/roadmaps/instar-two-goal-roadmap-2026-07.md (Phase 1); docs/audits/slack-ai-employee-audit-2026-07.md (§2 root gap, P0-1); docs/audits/mm-current-state-2026-07.md (P1-1)"
depends-on: "SlackAdapter routing keys (src/messaging/slack/SlackAdapter.ts:433-440 resolveRoutingKey — the thread⇄channel identity rules this spec adopts verbatim); the §10.5 conversation-key scheme (src/core/slackRefreshBinding.ts — SLACK_CONVERSATION_KEY_PREFIX + slackRoutingKeySyntheticId, the deployed precedent this spec extends rather than replaces); multi-machine replicated-store foundation (docs/specs/multi-machine-replicated-store-foundation.md — the replication vehicle, WS2 hardening rules reused as-is EXCEPT the per-kind auto-resolution hook §3.5); the session-pool string sessionKey space (src/core/SessionRouter.ts:55 — deliberately NOT changed); CommitmentTracker + PromiseBeacon (the first proof consumer)"
eli16-overview: "docs/specs/durable-conversation-identity.eli16.md"
project: "two-goal-roadmap Phase 1 (topic 29836)"
single-run-completable: false
---

# Durable, Channel-Agnostic Conversation Identity

## 0. Glossary (read before §2)

Five near-peer terms are used precisely throughout; conflating them is the #1
source of confusion in this design.

| Term | What it is | Lifetime / authority |
|---|---|---|
| **Conversation** | The logical thing a message belongs to — a Slack channel, a Slack thread, or a Telegram topic. The unit durable state (commitments, memory, notices) attaches to. | The real-world abstraction. |
| **Canonical key** (string) | The normalized identity string of a conversation: `slack:<teamId>:<channelId>[:<threadTs>]` (or `_` placeholder for an unknown teamId). A **normalized lookup string**, NOT the primary identity — see §3.1. | Mint-time identity plus upgradable metadata (teamId backfill). |
| **Structured tuple** | `(platform, channelId, threadTs?)` — the workspace-INdependent identity core. This, not the key string, is what the registry uses to decide "same conversation" on ingest (§3.5). | Immutable once minted. |
| **Minted id** (number) | The stable NEGATIVE integer the registry assigns a non-Telegram conversation. Every existing `number`-typed `topicId` field carries it unchanged. | Assigned once, resolves forever (§3.5). |
| **Transport sessionKey** (string) | The session-pool's opaque routing key (`C…`/`C…:<thread_ts>` for Slack, `"12476"` for Telegram). Deliberately UNCHANGED by this spec. | Owned by the session-pool layer. |
| **topicId** (number) | The pervasive Telegram-native id. Its VALUE domain now also includes minted ids; the field name and type are unchanged. | Positive = Telegram; negative = minted. |

The registry is the **join table** between canonical key, structured tuple, and
minted id. It never replaces the transport sessionKey space.

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

   Two further call sites consume the same hash and ride the §4 consolidation:
   `server.ts:9227` and `:10095` (standby/triage paths), plus `SessionRefresh.ts:422`.

Because nothing durable can attach to representation (2), every follow-through subsystem
that makes instar an employee on Telegram is structurally dead on Slack: commitments
(`Commitment.topicId?: number`, `src/monitoring/CommitmentTracker.ts:59`), PromiseBeacon
(injected `sendMessage(c.topicId…)` → `POST /telegram/reply/${topicId}` in the wiring at
`server.ts:13002-13012`), attention items (`routes.ts:12323-12327` — 503 without
Telegram), reap notices (`ReapNoticeDrain.ts:179`), cold-start fallback (a Slack spawn
failure is a `console.error`, `src/commands/server.ts:7508-7510` — the "always reachable"
floor does not exist on Slack), the autonomous heartbeat (`server.ts:13108-13119`). And
because the bridge is an unregistered in-memory hash, it is:

- **Lossy / one-way after restart**: a synthetic id whose channel is not in the
  pre-populate set (any thread-level id, any channel first seen mid-process) falls
  through PresenceProxy's Slack branch (`server.ts:12403-12414`) to the Telegram URL →
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
non-Telegram conversation, with the structured tuple as the canonical identity and the
key string as its normalized lookup form.** Consumers keep their `number`-typed `topicId`
fields verbatim.

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
4. **The session-pool layer needs NO change.** `SessionRouter.sessionKey` is already an
   opaque string (`src/core/SessionRouter.ts:55`), `POST /pool/transfer` already reads
   `topic` as a string (`routes.ts:13995`), and workspace-aware placement exists
   (`src/core/machineServesChannel.ts:27-64`). The registry sits BESIDE the transport
   key space as a join table, not a replacement of it.

**One conversation, three representations, one registry as the join point:**

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

### 3.1 Identity model — the tuple is identity, the key is its lookup form

**The primary identity of a conversation is the structured tuple
`(platform, channelId, threadTs?)` bound to a stable minted id.** The `workspaceId`
(teamId) is IDENTITY-ADJACENT METADATA, not part of the identity core — because the mint
candidate (§3.3) hashes the routing-key tail (`channelId[:threadTs]`), which excludes the
teamId. Making this explicit resolves the codex X1 finding and is load-bearing for the
ingest rules in §3.5.

The **canonical key** is the normalized display/lookup string, extending the DEPLOYED
§10.5 scheme (`slackRefreshBinding.ts:69-79` — `slack:<channel>[:<thread>]`) with a
workspace segment:

```
slack:<teamId>:<channelId>              — channel-level conversation
slack:<teamId>:<channelId>:<threadTs>   — thread-level conversation
telegram: (never stored — positive ids pass through)
(reserved prefixes: whatsapp:, imessage:, …  — same mint rules, out of scope here)
```

- `<teamId>` comes from `SlackAdapter.getWorkspaceId()` (`SlackAdapter.ts:386`, config-
  sourced, may be `undefined`). When genuinely unknown, the placeholder `_` is used AND
  the registry enforces uniqueness on the structured tuple — so a later teamId backfill
  upgrades the key **in place** (same id, `_` → concrete teamId, key string rewritten,
  journaled). **The id never changes; the tuple never changes; only the workspace metadata
  and the key string upgrade.**
- **Upgrade authority (KYP):** the in-place `_`→teamId upgrade is triggered ONLY by the
  LOCAL adapter's authenticated `getWorkspaceId()` — NEVER by replicated data, NEVER by
  message content. A replicated entry can never rewrite the workspace of a local
  conversation (§3.5). This closes the security-M3(a) identity-rewrite vector.
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
independently of the current routing mode). **Operator visibility (adversarial-A8):** when
a channel's `threadSessions` setting is flipped AND that channel has open
commitments/attention items on ids of the other granularity, a one-time log line + ONE
deduped attention item names the split ("future thread replies now bind to a different
conversation than your existing commitments here").

### 3.3 Mint rule — deterministic candidate + registry-checked probe

```
candidate(routingKey) = -(Math.abs(h) + 1)   where h = the deployed 32-bit sum-shift hash
                                             over the ROUTING KEY (thread-aware — the
                                             slackRoutingKeySyntheticId semantics)
mint(key):
  existing = registry.byTuple(tuple(key))    → return existing.id          (idempotent)
  id = candidate(routingKey(key))
  while registry.occupies(id) for a DIFFERENT tuple:  id -= 1              (probe DOWN)
  persist { key, tuple, id, … } durably (atomic write), THEN return id
```

- **`registry.occupies(id)`** treats an id as occupied if it is a live conversation's id
  OR appears in the alias table as either side — so a fresh mint can never land on an
  alias id (decision-completeness-D4; preserves the one-hop invariant).
- **Probe direction is DOWN (`id -= 1`) and is FROZEN FOREVER** (frontloaded decision 2).
  Rebuild determinism (§3.3 property 3) and cross-machine convergence both require every
  implementation, on every version, to probe identically.

Why the legacy hash is the candidate — three load-bearing properties:

1. **Zero-loss adoption.** Every synthetic id already durably written (TopicMemory
   message + summary rows; any PresenceProxy state) was computed by this hash over the
   routing key. A conversation's first mint lands on the SAME id the legacy code produced
   — existing history attaches to the registered conversation instead of orphaning.
2. **Mixed-fleet convergence with zero coordination.** During a version-skew window, an
   old server computes the hash directly; a new server mints via the registry with the
   hash as candidate. Same key → same id on both, without any cross-version protocol.
3. **Deterministic re-mint under registry loss (absent probes).** A rebuilt registry
   re-mints the same ids for the same keys **when no probe ever occurred**; the probe case
   is handled by journal replay (§6.2), NOT by re-mint (see the honesty note below).

**Collision-math honesty (scalability-S2, security-m3, decision-D4).** The candidate
space is effectively 31 bits (a 32-bit hash folded by `Math.abs`). The birthday bound is
real and must not be hidden:

| Live minted conversations | P(≥1 probe collision ever) |
|---|---|
| ~1,000 (channel-default, small org) | ~0.001% |
| ~10,000 | ~2% |
| ~55,000 | ~50% |
| ~100,000 (threads-enabled, busy org over time) | ~90% |

Every determinism claim in this spec is therefore scoped **"absent probes."** A probe is
NOT a data-loss event by itself (the registry assigns a fresh id and records it); the
danger is ONLY a rebuild that replays probes in a different order (§6.2 closes it via
journal replay). A wider candidate space (48-bit, within negative-safe-integer range) is
available for FUTURE thread-level mints if scale demands — deferred here because it breaks
zero-loss adoption and mixed-fleet skew convergence for the existing corpus; §11 tracks it.

Collision safety with real Telegram topic ids is **structural**: minted ids are always
`< 0`; Telegram `message_thread_id` values are always `> 0`. The registry validates
`id < 0` on every write and every replicated ingest (type-clamp). `0` is unmintable
(`-(abs+1)` ≥ 1 in magnitude).

**Mint-rate breaker (Bounded Blast Radius — adversarial-A4, security-m2).** Mint is gated
behind authorized senders (verified fail-closed, `SlackAdapter.ts:150-157,992-995`), but
any authorized sender, a looping bot, or a channel-rename/thread-flood storm can drive
unbounded durable entries. A per-channel, per-window mint budget sits at the mint
chokepoint: over-budget conversations STILL DELIVER (identity never costs a message — the
in-memory candidate id is used) but durable registration is deferred and ONE deduped
attention item names the episode. `GET /conversations/health` surfaces the entry count
and file size with a threshold attention item (the tripwire before the §3.4 growth cliff).

### 3.4 Storage

`state/conversation-registry.json` — house-style JSON store: atomic tmp→rename writes,
single-writer serialized `mutate()` (the CommitmentTracker/TopicProfileStore CAS
pattern), in-memory cache authoritative for reads, an in-memory **id→key reverse index**
(replacing the old `slackProxyChannelMap`), corrupt-file quarantine-aside with the one
deduped attention item (the TopicPlacementPinStore pattern). Entry shape:

```jsonc
{
  "version": 1,
  "conversations": {
    "slack:T0BA1DR0U3D:C0BA4F4E0FP": {
      "id": -83921477,
      "platform": "slack",
      "workspaceId": "T0BA1DR0U3D",       // identity-adjacent metadata, upgradable
      "channelId": "C0BA4F4E0FP",
      "threadTs": null,
      "mintedAt": "2026-07-02T21:00:00.000Z",
      "mintedBy": "<machineId>",
      "origin": "adopted-legacy-hash" | "minted-probed" | "adopted-replicated",
      "reachability": "ok" | "unreachable",   // non-identity delivery state (§5)
      "hlc": { "physical": 0, "logical": 0, "node": "…" },
      "label": "#engineering"            // display-only, refreshable, sanitized on render
    }
  },
  "aliases": { "-83921478": -83921477 }  // divergence repairs — LOCALLY derived only (§3.5)
}
```

**Growth honesty (scalability-S1 — the CommitmentTracker 2026-06-21 freeze precedent).**
The store is never-delete (identity must resolve forever). With thread routing DISABLED
(today's default) growth is one entry per channel — hundreds, trivially fine. But the
roadmap's Phase 7.2 flips thread routing default; threads-enabled at a busy org is
10k+/year/channel → 100k entries (~10–25MB) is reachable, and at that size a full
`JSON.stringify`+`writeFileSync`+`renameSync` per mint on the inbound path is the exact
pattern that froze production (CommitmentTracker.ts:366-375: ~1.6MB store, O(N)
serializations, event loop frozen for minutes, `/health` 000, watchdog SIGKILL loop).
Mitigations shipped WITH this spec, not deferred:
- The adoption pass (§6.2) and any burst run inside a **batched-save window** (one flush),
  mirroring CommitmentTracker's post-freeze `batchingSaves`.
- Delivery NEVER waits on the mint WRITE: the candidate id is returned immediately
  (determinism guarantees it equals the persisted id absent probes) and persistence
  completes async; queue overflow (the CommitmentTracker `MUTATE_QUEUE_MAX_DEPTH=256`
  precedent) degrades to the §3.6 pending-mint path.
- `GET /conversations/health` carries `entryCount` + `fileSizeBytes` with a threshold
  attention item (design ceiling stated: ~50k entries / ~10MB is the JSON-store ceiling).
- **Named escape hatch (not deferred silently):** past the ceiling, migrate to
  snapshot + append-journal (the `logs/conversation-registry.jsonl` audit is already half
  of it) or SQLite (the pending-relay-store precedent). §11 tracks it as a planned
  migration, so 100k entries is a scheduled move, never an incident.

The file joins `config.backup.includeFiles` via PostUpdateMigrator exactly as
`state/topic-profiles.json` + `state/topic-operators.json` did
(`PostUpdateMigrator.ts:8905-8944` — durable identity class; stateDir-RELATIVE path
shape per the pinned round-6 lesson). **Backup restore is the PRIMARY disaster-recovery
path** (gemini-G2); journal replay (§6.2) is the secondary; deterministic re-mint is the
last resort with the documented probe-order risk.

### 3.5 Multi-machine replication semantics

**Posture declaration (Cross-Machine Coherence — mandatory).** The registry is
**machine-local at the mint site** (the owning/serving machine mints; §3.5 below) and
**replicated as a dark WS2 store** (`multiMachine.stateSync.conversations`, §9). Delivery
resolution is **owning-machine-authoritative** (§5). A single-machine agent is a strict
no-op.

**Mint authority: the machine that owns/serves the conversation.** Inbound dispatch on
the owner is the minting site. Same-key concurrent mints are structurally rare; the
deterministic candidate makes even a genuine race CONVERGENT.

**Reused WS2 hardening, applied to this store, PLUS the hardening the security/lessons
round required:**

- **Type-clamp on ingest**: `id` must be a negative safe integer; `platform` **enum-clamped**
  to a minted platform (`slack` today; never `telegram`, never unknown); `channelId`
  shape-clamped (`^[CDG][A-Z0-9]+$`), `threadTs` shape-clamped (`^\d{10}\.\d{6}$` or null);
  `key` regex `^slack:[A-Za-z0-9_.:-]+$`; timestamps ISO-8601-only; `hlc.physical`
  **clamped to a sane window around receipt time** (a forged `{physical:0}` cannot win the
  alias tiebreak); `label` length-bounded AND sanitized/escaped on every render surface
  (`GET /conversations`, dashboard) as untrusted peer data (WS2 render-safety).
- **id↔key coherence check (security-M1, adversarial-A3).** On ingest the registry
  recomputes `candidate(routingKey(key))` and accepts the entry ONLY if `id === candidate`
  OR `id` is within a small bounded probe distance of the candidate AND that probe is
  itself explained by a locally-visible occupancy. An entry claiming an id unrelated to
  its key is **quarantined-aside + one deduped attention item**, never applied. This
  removes the pre-squat/preimage capture vector: a peer can no longer replicate
  `{attacker-key, id=candidate(victim-key)}`.
- **Cross-machine identity = the STRUCTURED TUPLE** (`(platform, channelId, threadTs)`),
  NOT the key string and NOT a local ordinal. This is the fix for the placeholder-skew
  false-forgery (integration-I1, decision-D1, lessons-F5, security-M3b):
  - **Same tuple, one side's teamId is `_`**: the SAME conversation. Apply as the §3.1
    in-place metadata upgrade (concrete teamId wins, journaled, id + tuple unchanged) —
    NEVER a seize refusal.
  - **Same tuple, same id, different label/metadata**: normal metadata merge (latest
    non-identity field wins; label refresh).
  - **Same tuple, DIFFERENT id** (a probe occurred on one side): deterministic winner =
    the entry with the LOWER HLC (tiebreak: lexicographically smaller machineId); the
    loser id is recorded in `aliases` resolving to the winner. Both machines apply the
    same rule → convergence. `resolve(aliasId)` returns the winning conversation (aliases
    are followed exactly one hop; the registry forbids alias chains by resolving at write
    time). ONE deduped attention item surfaces the episode.
  - **DIFFERENT tuple, SAME id** (a genuine seize attempt / corrupt entry): REFUSED,
    quarantined-aside, one deduped attention item. Never applied.
- **Aliases are NEVER ingested from peers (security-M2).** Each machine derives its alias
  table LOCALLY by applying the same-tuple-different-id rule to its own merge. A replicated
  payload carrying alias data has that data stripped; an entry that is only an alias is
  refused. (The alias table is local repair state, not replicated identity.)
- **Replicated entries are ADVISORY until locally corroborated (security-M1, KYP).** A
  freshly-ingested entry carries no delivery authority: `deliverToConversation` (§5)
  resolves ONLY through entries whose origin is local (`adopted-legacy-hash` |
  `minted-probed` | `adopted-replicated`). A pure `replicated`-origin entry the local
  adapter has never corroborated is read-context only; the FIRST authenticated inbound on
  that tuple upgrades it to `adopted-replicated` (a local mint-hit), at which point it
  becomes deliverable. Since delivery belongs on the owning machine anyway (§5), this costs
  nothing operationally and closes the DM→public-channel leak.
- **Local-origin adoption defeats rollback-unmerge orphaning (lessons-F6).** The foundation's
  `stateSync.<store>` disable atomically DROPS a peer origin's namespace from the union. To
  ensure that can never orphan a locally-bound id, EVERY entry a local durable consumer
  binds to (i.e. every entry on first local resolve/mint-hit) is copied into the LOCAL
  origin namespace as `adopted-replicated`. Un-merging a peer then cannot remove an id this
  machine actually uses.
- **Auto-resolution is a NAMED per-kind departure from the foundation conflict contract
  (lessons-F7).** The replicated-store foundation "NEVER picks a winner — that is the
  operator's" for divergent edits. This store deliberately AUTO-resolves same-tuple-
  different-id divergence (lower-HLC winner + alias) because the outcome is
  SEMANTICALLY CONVERGENT — both ids resolve to the same conversation, no data is lost, and
  a human decision would add nothing. Mechanism: the conversations store registers a
  **per-kind auto-resolution hook** with the foundation; the foundation's standard
  preserve-both + `conflictId` operator surface is SUPPRESSED for this kind (so the two do
  not run dueling resolution paths). One deduped attention item still surfaces every alias
  episode for observability. This departure is scoped to THIS store's convergent-semantics
  case only.
- **Tombstones**: none. Conversations are never deleted (an id that ever entered a durable
  store must resolve forever). Registry entries are append-only plus in-place metadata
  upgrades (§3.1 teamId backfill, label refresh, reachability).

### 3.6 Failure modes (decided)

| Failure | Behavior |
|---|---|
| Registry unavailable/corrupt at inbound time | **Fail toward delivery**: compute `candidate(routingKey)` in-memory — byte-identical to today's legacy behavior — proceed, and journal a pending-mint (keyed/deduped by canonical key: ONE pending-mint per conversation, not per message; bounded with a loud drop counter). Corrupt file → quarantine-aside + rebuild (§6.2). |
| Registry present but SLOW/contended | Delivery never waits on the mint WRITE: candidate id returned immediately, persistence async; mutate-queue overflow degrades to the pending-mint path (never a blocked inbound). |
| Pending-mint heal collision | The heal re-runs `mint()` (probe + alias) rather than assuming determinism — if the candidate was occupied by a different tuple during the outage, the heal aliases the in-memory id that consumers already received to the registered winner (§3.5 alias rule). |
| Two machines mint the same tuple concurrently | Same candidate → same id → replication merges silently. Probe divergence → §3.5 alias rule, deterministic on both sides. |
| A peer replicates garbage | Type-clamp + id↔key coherence + tuple-first matching + seize-refusal + alias-not-ingested (§3.5). Fails closed on the registry write, never on message delivery. |
| Mint requested for an unparseable/foreign key | Refused (typed error). Callers treat it as "no durable id" and keep legacy behavior for that message. |
| Registry lost AND journal lost AND no backup | Deterministic re-mint from the channel registry (§6.2), with the documented probe-order risk. This residual is the ONE true "aliases may be needed / re-verify" window; it raises an attention item. |

## 4. Retiring the hash copies (foundation increment)

One new module, `src/core/conversationIdentity.ts`, absorbs `slackRefreshBinding`'s key
helpers and exports the SINGLE hash + mint surface. The copies become delegates:

| Today | Becomes |
|---|---|
| `server.ts:12194` `slackChannelToSyntheticId(channelId)` + `slackProxyChannelMap` | `registry.mintForRoutingKey(channelId)`; the in-memory reverse map is replaced by `registry.resolve(id)` (the §3.4 id→key index). The pre-populate loop (`:12206-12212`) becomes the §6.2 adoption pass. |
| `server.ts:9227`, `:10095` (standby/triage) | Delegate to the single `registry.resolve`/`mintForRoutingKey` surface. |
| `routes.ts:11553-11558` inline hash (build heartbeat) | `ctx.conversationRegistry.mintForRoutingKey(channelId)` (ctx-injected like every other store). |
| `slackRefreshBinding.ts:96` `slackRoutingKeySyntheticId(routingKey)` + `SessionRefresh.ts:422` | Re-exported FROM `conversationIdentity.ts` as `candidateIdForRoutingKey` — it is the mint candidate, no longer an identity authority. |

This increment is **behavior-identical by construction** for every existing conversation
(same ids, now durable + resolvable + collision-checked) and fixes the PresenceProxy
restart hazard (§1) as a side effect.

The negative-id sniffing scattered through server.ts collapses onto `registry.resolve(id)`
returning a typed channel descriptor — `{ platform:'slack', channelId, threadTs? }`.
**PresenceProxy's system-channel suppression is preserved (security-m4):** the
`isSystemChannel` refusal at `server.ts:12406-12408` moves INTO `deliverToConversation`
(§5) so standby/beacon noise still never lands in dashboard/lifeline channels.

## 5. The outbound funnel — `deliverToConversation`

A single delivery helper (server-bootstrap-wired, ctx-exposed) that every follow-through
consumer migrates onto. **The opts contract is pinned** (lessons-F9) so swapping the
injected `sendMessage` cannot silently change delivery semantics:

```
deliverToConversation(id: number, text, opts: {
    isProxy?, source?, tier?, allowDuplicate?, messageKind?,   // passed through per-arm, unchanged
    deterministic?: boolean                                    // reachability-floor / resource-denial arm
}):
  id > 0  → today's Telegram path (POST /telegram/reply/:id) — queue, dedup, idempotency,
            tone gate: all existing layers, and proxy sends keep their existing
            isProxy tone-gate-bypass EXACTLY as today (no new gating introduced).
  id < 0, deterministic:true → GATE-EXEMPT deterministic Slack send (direct
            ctx.slack.sendToChannel with thread_ts), for reachability-floor / resource-
            denial notices ONLY — mirrors the Telegram G1 design so the "always reachable"
            floor on Slack is never held by the tone gate failing closed under the very
            pressure it reports (lessons-F3 / The Agent Is Always Reachable corollary 2).
  id < 0 (normal) → registry.resolve(id) on the OWNING machine → POST /slack/reply/:channelId
            with thread_ts (the route runs the tone gate — routes.ts:12163-12186; thread-
            level conversations deliver IN-THREAD). Proxy sends carry isProxy so the Slack
            arm honors the same bypass as the Telegram arm (beacon parity).
  id < 0 on a NON-owning machine, or unresolvable, or no local Slack adapter → TYPED FAILURE
            (never a silent drop, never a success-shaped return; §5.1). ONE deduped
            attention item names the heal paths.
```

**§5.1 The failure/dryRun contract (adversarial-A1/A6, lessons-F4 — the flagship-consumer
safety).** A funnel non-delivery is a **typed, NON-EXCEPTIONAL return** the caller
inspects — never a thrown exception that skips beacon re-arm, and NEVER success-shaped:

- `dryRun` (and fleet-dark) returns the SAME `not-delivered` typed result the
  unresolvable path uses, plus a `would-deliver` audit line. It is caller-visible as a
  non-delivery, so beacon retry / attention escalation keep engaging. "Strictly less wrong
  than today" holds ONLY because the no-op is a visible non-delivery, not a fake success.
- PromiseBeacon's `fire()` re-arms in `finally` and, after N consecutive `not-delivered`
  results, escalates via `raiseAttention` — so a funnel failure can never silently kill
  the beacon timer (today's `fire()` skips re-arm on throw — this is fixed as part of the
  proof-consumer increment).
- **Permanent-vs-transient classification (adversarial-A2, codex-X4).** The Slack arm
  classifies `channel_archived` / `channel_not_found` / `not_in_channel` as a PERMANENT
  `conversation-unreachable`: the registry entry's `reachability` flips to `unreachable`
  (non-identity metadata, never deletion), and the beacon treats it as TERMINAL → ONE
  `raiseAttention` dead-letter, commitment surfaced to the operator instead of retried
  forever. Transient errors retry per existing behavior.

**§5.2 Bounded notification surface (P17 — lessons-F8).** The funnel is the ONE chokepoint
every migrated consumer rides, so the per-conversation delivery budget lives HERE: `id < 0`
deliveries carry a per-conversation rate budget + aggregation rule (mirroring Telegram's
`topicCreationBudget`/`AttentionTopicGuard`/duplicate-suppression). A flood of attention
items or reap notices on minted ids coalesces into a bounded Slack stream, not the
2026-05-22/05-28/06-05 topic-flood shape. §10 adds the burst-invariant test (1,000-item
burst → bounded messages).

Hardening that ships with the funnel: `POST /telegram/reply/:topicId` gains a 400 on
`topicId < 0` ("negative = minted conversation — use the conversation funnel"), assigned
to the FUNNEL increment (not the foundation — it is a behavior change). A grep-audit
confirms no live caller sends `reply/0` (General-topic semantics); the 400 is classified
**terminal/non-retryable** in PendingRelayStore + DeliveryFailureSentinel so no negative-id
row retries forever.

Explicitly NOT in this funnel (non-goals, Phase 2.1): a Slack PendingRelayStore lane,
DeliveryFailureSentinel `channel:'slack'`, delivery-id idempotency for Slack, the
GFM→mrkdwn formatter. The funnel delivers through the EXISTING `/slack/reply` with its
current robustness (tone gate + the classification above). Robustness parity is the next
roadmap item and slots in UNDER this funnel without changing its callers.

## 6. Consumer migration — order, shims, and what each needs

### 6.0 Inventory (verified against JKHeadley/main v1.3.722)

| # | Consumer | Numeric coupling (file:line) | What it needs from a durable id |
|---|---|---|---|
| 1 | Commitments | `Commitment.topicId?: number` (`CommitmentTracker.ts:59`); beacon requires topicId (`routes.ts:21811-21815`, `!topicId` truthy check accepts negatives) | A number, stable across restarts, deliverable both platforms. Minted id satisfies all three. |
| 2 | PromiseBeacon | injected `sendMessage(c.topicId…)` → wiring `server.ts:13002-13012` | Swap the injected `sendMessage` to `deliverToConversation` (§5 opts contract pinned; fire() re-arm fix). |
| 3 | Attention queue | `AttentionItem.topicId?: number` (`TelegramAdapter.ts:273`); 503 without Telegram (`routes.ts:12323-12327`); existing Slack attention-channel mirror (`state.get('slack-attention-channel')`, `server.ts:2853/3263/7636`) | Accept items on minted ids; deliver via funnel (per-conversation Slack ack UX = Phase 2.3; until then Slack items ride the existing attention-channel mirror). |
| 4 | Reap notices + PendingRelayStore | `topic_id INTEGER NOT NULL` (`pending-relay-store.ts:111`); drain via `sendToTopic(row.topic_id…)` (`ReapNoticeDrain.ts:179`) | NO schema change — a minted id IS an integer. Only the drain's send resolves via the funnel; 400-on-negative classified terminal here. |
| 5 | DeliveryFailureSentinel | hardcodes `channel:'telegram'` (`delivery-failure-sentinel.ts:440`) | Phase 2.1 (non-goal here); the funnel gives it the resolve primitive. |
| 6 | Cold-start fallback | Slack spawn failure = `console.error` (`server.ts:7508-7510`) | Mint at Slack inbound (§6.3) + funnel DETERMINISTIC arm (§5) → the reachability floor finally exists on Slack, gate-exempt. |
| 7 | AutonomousProgressHeartbeat | unconditional `/telegram/reply` (`server.ts:13108-13119`) | Funnel swap of the injected sendMessage. |
| 8 | Autonomous runs | `<stateDir>/autonomous/<topic>.local.md`, `topic: string \| number` tolerant (`AutonomousSessions.ts:24,108-111`) | Nothing structural — minted ids stringify fine. |
| 9 | Topic-operator | store union-ready (`TopicOperatorStore.ts:39,105`); auto-binds Telegram-gated | Route accepts minted ids as-is. Slack KYP auto-bind = Phase 3.1, keyed on the minted id this spec provides. |
| 10 | Topic-bindings | `Number(topicId)` (`routes.ts:5988`); `CoherenceGate` `topicId?: number` | Minted ids pass unchanged. |
| 11 | Topic-profiles | store + resolver union-ready | Minted ids pass unchanged; the §10.5 Slack refresh arm now shares ids with everything else. |
| 12 | Working-set carrier / profile acquire seam | `Number(cmd.session)` + `Number.isFinite` gates (`server.ts:18213-18219`); `onTopicAccepted(topic: number)` (`WorkingSetPullCoordinator.ts:117`) | At the onAccepted seam: non-numeric sessionKey → `registry.idForSessionKey(key)` **defined as get-or-create** (a named mint chokepoint) → fire the carrier with the minted id. |
| 13 | Pool transfer/placement | already string-typed `topic` (`routes.ts:13995`) | Nothing — transport keys stay strings. |
| 14 | Escalation (models tier) | `EscalationHintStore` string-keyed | Nothing structural. |
| 15 | Resume queue | `topicId?: number` (`ResumeQueue.ts:65,187`) | Minted ids pass unchanged. |
| 16 | Message stores / TopicMemory | `topic_id INTEGER` (`TopicMemory.ts:249,288`); dual-write hashes bare channelId (`server.ts:13216-13227`) | NO schema change. **DECIDED (adversarial-A7):** the dual-write keys on the RESOLVED conversation id going forward (§3.2); pre-existing thread rows written under the channel id stay channel-attached (named + accepted, mirroring the §3.2 mode-flip consequence style) — no silent history split, no memory-gap. |
| 17 | PresenceProxy / standby | synthetic ids + in-memory map (`server.ts:12193, 12402-12430`) | Foundation increment (§4). Fixes the restart fall-through bug; system-channel suppression preserved (§4). |
| 18 | Session↔topic maps | Slack routing-key-keyed (`SlackAdapter.ts:189-190`) | UNCHANGED — transport keys stay routing keys (§2 point 4). |
| 19 | Ingress exactly-once ledger | schema generic (`MessageProcessingLedger.ts:75`); Slack has in-memory `seenMessageTs` only | Phase 2.2 (non-goal); `dedupeKeyFor` already accepts string topics. |
| 20 | Jobs / decision journal / privacy scopes | `JobDefinition.topicId?: number` etc. | Minted ids pass unchanged. |

### 6.1 Migration order (each increment independently shippable + live-provable)

1. **Foundation** (§3 + §4 + §5 funnel skeleton): registry, hash consolidation, resolve
   routes, `deliverToConversation`. Behavior-identical; ships live.
2. **Commitments + PromiseBeacon — THE proof consumer** (roadmap Phase-1 live proof):
   Slack inbound mints eagerly (§6.3, ships live/ungated with THIS increment); the
   session's commitment carries the minted id; beacon heartbeats deliver through the
   funnel into the exact thread; fire() re-arm + typed-failure contract (§5.1) land here.
   *Live proof:* create a commitment from a Slack THREAD, restart the server, watch the
   beacon heartbeat land back in that thread.
3. **Cold-start fallback**: Slack spawn failure answers in-channel through the funnel's
   DETERMINISTIC gate-exempt arm (kills the `console.error` hole; extends "The Agent Is
   Always Reachable" to Slack without riding the fail-closed tone gate).
4. **AutonomousProgressHeartbeat** funnel swap.
5. **Attention items**: accept + deliver on minted ids via the funnel's P17-budgeted
   `id<0` path (per-conversation Slack ack UX stays Phase 2.3).
6. **Reap notices / PendingRelay drain** funnel swap (schema untouched).
7. **Working-set / profile-carry seam** (§6.0 #12): `idForSessionKey` get-or-create at
   `onAccepted` — Slack conversations join Goal-2 transfer machinery.
8. **Route-surface cleanups**: the 26 `Number()` coercions audited (**acceptance criterion:
   each coercion either accepts negatives verbatim — test-pinned for the routes commitments/
   attention/profiles touch — or is documented Telegram-scoped like `routes.ts:24915`**).

**Dark-window honesty (adversarial-A6).** While `followThrough` is dark/dry, a session
CAN mint an id and open a commitment on it. To avoid a silently-broken promise, the
commitment path in that state either (a) returns a typed `undeliverable-while-dark` the
session surfaces conversationally, or (b) accepts it and immediately raises ONE deduped
attention item marking it undeliverable. Chosen: (b) on the dev agent (where the soak
runs and the operator watches), because it preserves the commitment record for the live
proof; the fleet never reaches this state until `followThrough` graduates. Silence is not
an option either way.

### 6.2 Adoption pass + rebuild (boot-time ensure; PostUpdateMigrator backup-manifest entry)

**Supervision Tier 0 (P7 — lessons-F11):** the adoption pass and funnel are pure
deterministic data transforms with no policy decision — Tier 0, justified by golden-parity
determinism, declared explicitly here.

Idempotent, boot-time ensure (inside a batched-save window, §3.4): for every channel in
`slack-channel-registry.json`, `mint(slack:<team>:<channel>)`. This pre-registers all
known channel-level conversations with their legacy-hash ids before any consumer asks.

**Rebuild after registry loss (scalability-S2, adversarial-A5, security-m3, lessons-F10):**
recovery order is (1) restore `state/conversation-registry.json` from BACKUP (primary);
(2) if no backup, REPLAY `logs/conversation-registry.jsonl` (§8 — append-only, records
every mint/probe/alias with key+id+order, so thread-level entries AND probe order are
restored exactly); (3) only if the journal is ALSO gone, deterministic re-mint from the
channel registry, with the documented probe-order risk and an attention item. The audit
log's retention (§8) MUST exceed the backup cadence so replay is always available between
backups.

PostUpdateMigrator additions: (a) `state/conversation-registry.json` into
`config.backup.includeFiles` (idempotent set-union, stateDir-relative); (b) the CLAUDE.md
Capabilities entry for `GET /conversations*` via `migrateClaudeMd()` (content-sniffed,
idempotent — reaches EXISTING agents, not just new inits; integration-I5); (c) nothing
else — no store rewrites anywhere.

### 6.3 Eager mint at Slack inbound + session surface

The Slack inbound dispatch (`server.ts:7317-7511`) mints (get-or-create) the conversation
id for the resolved routing key on EVERY inbound — one cached registry read after the
first. **This surface ships LIVE and UNGATED with increment 2** (the dryRun soak depends
on sessions already creating minted-id commitments; the foundation is always-on recording,
`followThrough` gates DELIVERY only) — stated explicitly (decision-D3).

The minted id is carried in the session bootstrap context and message metadata under the
**pinned field key `conversationId`** (an on-disk/metadata format, frozen; only the
human-readable prompt phrasing is build-time cheap-to-change) so the session can attach
durable state to it (`POST /commitments` with `topicId = <minted id>`). The dispatch's
binding gap named in the audit closes to "creates the identity everything else can bind to."

## 7. Security — the id is routing identity, never authority

- **Know Your Principal is untouched.** Operator binding still happens ONLY through
  authenticated-sender writes (`TopicOperatorStore.setOperator` — `server.ts:2051`,
  `routes.ts:17253-17262`). A conversation id names WHERE a conversation is, never WHO
  commands it.
- **A replicated entry is ADVISORY, never delivery authority (security-M1, KYP).** This
  is the load-bearing security invariant: `deliverToConversation` resolves ONLY through
  LOCAL-origin entries (§3.5); a `replicated`-origin entry is read-context until the local
  adapter corroborates the tuple. This matches the WS2 posture ("advisory at the read
  layer, never authoritative") that the foundation's PII stores enforce.
- **A peer cannot forge, squat, or collide an id to steal delivery** (the named threats):
  - id↔key coherence check on ingest (§3.5) — an entry whose id ≠ candidate(key) is refused.
  - Rebinding an existing tuple→id: refused (no-clobber).
  - Seizing an existing id under a different TUPLE: refused + quarantined.
  - Aliases never ingested from peers (§3.5) — no one-hop redirect capture.
  - Minting a positive id (colliding with a real Telegram topic): structurally impossible
    (`id < 0` clamp).
  - `_`→teamId upgrade only by the local authenticated adapter (§3.1) — no identity-rewrite
    via replication.
- **The mesh-forward replay path is shape-validated at the owner mint site (security-M1c):**
  `server.ts:18233-18246` → `slackInboundDispatch` → the §6.3 mint validates
  `channelId`/`threadTs` shape before minting, so a compromised peer cannot supply a
  crafted routing key to force a target candidate.
- **At-rest honesty** (same posture as `slack-channel-registry.json`): the registry is
  plaintext machine-local; it reveals WHICH channels/threads the agent talks in (ids +
  labels), never message content, tokens, or principals.
- **No write routes exist** (stronger than "Bearer-gated"): mint happens only at internal
  server-side chokepoints (inbound dispatch, adoption pass, funnel resolve); `GET
  /conversations*` are read-only. There is no unauthenticated — or authenticated — external
  mint surface.

## 8. Observability

- `GET /conversations` — inventory (`?platform=slack`, `?limit=`), entries as §3.4
  (label sanitized) plus the alias table; `entryCount` + `fileSizeBytes`.
- `GET /conversations/:id` — resolve one id: minted → the full entry (+ `aliasOf` when
  applicable); positive → `{ platform:'telegram', topicId, passThrough:true }`; unknown
  negative → 404 with the honest "never minted on this machine" body.
- `GET /conversations/resolve?key=…` (or `?sessionKey=…`) — forward lookup, mints NOTHING
  (read-only).
- `GET /conversations/health` — counts by platform/origin, alias count, adoption-pass
  state, `entryCount`, `fileSizeBytes`, quarantine state, last mint, mint-budget state.
  The e2e "feature is alive" target.
- `logs/conversation-registry.jsonl` — append-only audit of every mint/adopt/alias/probe/
  refusal (ids + keys only, never content). **Rotation:** size/line-capped with retention
  EXCEEDING the backup cadence (so §6.2 journal replay is always available between
  backups) — the one rotation whose floor is a recovery requirement, not just hygiene.

## 9. Config, rollout, migration parity

```jsonc
"conversationIdentity": {
  // Foundation (registry + consolidation + resolve routes + eager mint): ALWAYS ON once
  // shipped — behavior-identical recording of ids already in use (the reap-log posture).
  // No off-switch for recording; the lever below reverts DELIVERY, not bookkeeping.
  "followThrough": {
    // enabled: OMITTED — the developmentAgent gate resolves it (live-on-dev, dark-fleet).
    //   NEVER materialized as a literal by migrateConfig (a default-shaped `false` would
    //   force-dark even a dev agent — the #1001 mechanism). Pinned by a unit test.
    "dryRun": true          // true-FIRST: delivery is externally visible, so dry-run the
                            // funnel (would-deliver audit lines, typed non-delivery per
                            // §5.1) before a deliberate dryRun:false flip on dev for the
                            // live proof. Distinct from the WS2 replication stores, which
                            // run dryRun:false because replication is non-destructive.
  }
},
"multiMachine": { "stateSync": { "conversations": {
    // enabled: OMITTED — registered in DEV_GATED_FEATURES (live-on-dev, dark-fleet), matching
    //   the 7 deployed stateSync stores moved out of DARK_GATE_EXCLUSIONS on 2026-06-13.
    "dryRun": true          // dryRun-FIRST for the FIRST soak window ONLY: the ingest-
                            // hardening paths (type-clamp, id↔key coherence, seize-refusal,
                            // quarantine, alias derivation) are the new trust boundary — soak
                            // them applying-nothing-but-auditing on dev, then graduate to
                            // dryRun:false (matching the WS2 non-destructive posture).
} } }
```

- **Foundation ships live** (§4 refactor: same ids, one copy, now durable). Safety net:
  determinism + the golden parity tests (§10).
- **Dev-agent maturation path is EXPLICIT (Maturation Path standard — lessons-F1,
  security-M4):** both blocks OMIT `enabled` and register in `DEV_GATED_FEATURES` so they
  are LIVE on a development agent (dark for the fleet) — say it as "dark for fleet, live on
  dev," never "ships dark." Each `dryRun` posture is justified inline (delivery is
  externally visible → dryRun-first; replication is non-destructive → the standing WS2
  stores run dryRun:false, and this store graduates to match after its first hardening
  soak). This is the deployed WS2 ladder, not the stale prose ladder.
- **Migration parity** (the standard's checklist): config defaults →
  `migrateConfig()` NEVER materializes `conversationIdentity.followThrough.enabled` or
  `stateSync.conversations.enabled` (only `dryRun:true` may be added, existence-checked,
  per the playwrightRegistry precedent) — pinned by a unit test asserting the migrator
  never writes those `enabled` keys; backup manifest → §6.2; CLAUDE.md Capabilities entry
  via `migrateClaudeMd()` (§6.2); no hook/template/skill changes.
- **Rollback**: `followThrough` (dev-gate → off, or dryRun:true) reverts all delivery
  behavior; the registry file is inert data under rollback (verified: zero old-code reads
  of `state/conversation-registry.json`). The hash consolidation is rollback-by-revert
  (pure refactor, no data format at risk).

### Fleet-skew window (both directions, explicitly)

- **Old server + new store**: old code never opens `conversation-registry.json`; it
  computes hash ids directly — value-identical. Zero data loss.
- **New server + old stores**: adoption pass fills the registry from existing state; every
  consumer store is read UNCHANGED — no store version bump anywhere in this spec.
- **Mixed-fleet minting**: §3.3 property 2. The one divergent case (probe) is detected +
  aliased + surfaced — the case that silently corrupts TODAY.
- **Cross-machine resolution during the dark-replication window (integration-I2):**
  commitments already replicate (`CommitmentsSync`), so a lease move can hand a machine a
  commitment on a minted id it never minted. `resolve(id)` fails there (the hash is
  one-way). Declared behavior: `idForSessionKey` is get-or-create (§6.0 #12), delivery is
  owning-machine-authoritative (§5 — a non-owning machine typed-fails + raises ONE deduped
  attention item naming the heal paths), and **enabling `stateSync.conversations` is the
  supported posture for multi-machine Slack follow-through** (the proof-consumer increment
  §6.1 step 2 names this coupling). Until then, single-Slack-machine deployments (today's
  reality) are unaffected.

## 10. Tests (Testing Integrity Standard — three tiers + wiring + alive)

**Tier 1 — unit** (`tests/unit/conversation-registry.test.ts` + funnel unit):
- Mint idempotency (same tuple → same id, across process restarts via re-open).
- **Golden parity**: `candidateIdForRoutingKey` reproduces the EXACT ids of all three
  legacy copies for channel-level keys, and of slackRefreshBinding for thread keys.
- Probe: seeded collision → next-lower id; probe skips alias ids; both orderings converge
  post-merge.
- Ingest clamps: positive/foreign-platform id refused; malformed key/shape refused; rebind
  refused; **id≠candidate(key) refused + quarantined**; seize (same-id-different-tuple)
  refused; **placeholder-skew (same-tuple, `_` vs real teamId) MERGES both orderings, no
  false forgery**; **replicated alias payload refused**; HLC physical clamp; alias
  one-hop-only invariant.
- resolveRoutingKey mapping table (§3.2) — every row, both directions.
- **Rebuild-from-journal**: corrupt file → journal replay → ids (incl. thread-level +
  probed) equal pre-corruption; journal-gone fallback flagged with attention.
- Funnel: `id>0` → telegram; `id<0` resolved-local-origin → slack with thread_ts;
  `id<0` replicated-only-origin → NOT deliverable; `deterministic:true` → gate-exempt path;
  non-owning-machine → typed failure; **dryRun → typed non-delivery (NOT success) + audit
  line**; permanent-error → `conversation-unreachable` + dead-letter; system-channel
  suppression preserved; opts pass-through (isProxy/dedup) per-arm.
- **Beacon survives + escalates a funnel typed failure** (fire() re-arm in finally; N-fail
  → raiseAttention) — the flagship-consumer safety test.
- **Burst-invariant (P17)**: 1,000 attention items on one minted id → bounded Slack messages.
- Mint-rate breaker: over-budget conversation still delivers (in-memory candidate) + defers
  durable registration + one attention item.

**Tier 2 — integration** (full HTTP pipeline):
- `GET /conversations*` routes: list/resolve/health, 404 semantics, Bearer auth, label
  sanitized on render.
- `POST /commitments` with a minted id → beacon tick → funnel → mocked Slack adapter
  receives channel + thread_ts.
- `/telegram/reply/:topicId` 400-on-negative, classified terminal in relay/DFS.
- Inbound dispatch mint: synthetic Slack inbound → registry entry exists, session metadata
  carries `conversationId`, second message mints nothing new.
- migrateConfig NEVER writes `followThrough.enabled` / `stateSync.conversations.enabled`.

**Tier 3 — e2e "feature is alive"** (mirrors server.ts production init): boot the real
server wiring, assert `GET /conversations/health` answers **200, not 503**, adoption pass
ran, and a full inbound→mint→commitment→restart→beacon→delivery cycle completes against
the fixture adapter. The single most important test in the spec.

**Wiring integrity**: ctx.conversationRegistry non-null in the production init path; the
former hash callsites delegate to the ONE export — a grep-ratchet lint SCOPED TO THE MINT
IDIOM `-(Math.abs(<hash>) + 1)` (NOT the bare `(hash<<5)-hash` literal, which also appears
in `TelegraphService.ts:530` for unrelated change-detection — security-m1) makes a fourth
mint copy a CI failure.

**Live proof script** (roadmap clause, test-as-self on the dev agent against the Slack
live-test workspace): post in a thread in a test channel → agent commits "I'll report back
in 10 minutes" (visible in `GET /commitments` with the minted id) → server restarted →
beacon heartbeat arrives IN THAT THREAD → commitment delivered/closed. Recorded per the
Live-User-Channel-Proof scenario-matrix standard.

## 11. Non-goals (blast radius kept honest)

1. **Slack outbound robustness** — queue/retry/dedup/idempotency/formatter/
   DeliveryFailureSentinel lane (roadmap Phase 2.1, tracked in the ratified roadmap under
   topic 29836 — Deferral=Deletion honored). The funnel delivers with `/slack/reply`'s
   current guarantees plus the §5.1 permanent-error classification.
2. **SlackLifeline instantiation** and **socket-follows-lease / Slack exactly-once ingress
   ledger** (Phase 2.2). The registry provides the key they will use; the Phase-2.2 ledger
   MAY key on the canonical key or `(channel, ts)` — `dedupeKeyFor` accepts either; nothing
   here constrains it.
3. **KYP on Slack** (operator auto-bind from authenticated Slack senders — Phase 3.1). This
   spec provides the id the binding attaches to; it creates no bindings.
4. **Per-conversation attention-item ack UX on Slack** (reaction vs interaction button —
   Phase 2.3). This spec only makes the item addressable; items on minted ids deliver via
   the funnel's P17-budgeted path meanwhile.
5. **Permission-gate enforce, responseReview, message_changed/reaction handling,
   multi-workspace adapters, thread-sessions default** — Phases 0/2/7, untouched.
6. **Re-keying the session-pool transport layer** — sessionKeys stay routing-key strings.
7. **Renaming `topicId`** across the codebase — churn without value; the field name stays,
   its VALUE domain now includes minted ids.
8. **Slack Connect shared channels** (adversarial-A11): a shared channel carries one
   channel id visible from multiple workspaces. Shared-channel identity policy is DECIDED
   IN Phase 7.1; the `_`-placeholder teamId backfill MUST NOT merge/split existing entries
   for shared channels — reserved-note so Phase 7.1 doesn't inherit a trap.
9. **A wider (48-bit) candidate space + full decoupling from the legacy hash**
   (gemini-G1): the legacy 32-bit hash is a TRANSITIONAL dependency (the mint CANDIDATE,
   with the registry as the collision authority). Once adoption is complete, a future
   change MAY introduce a wider id scheme for NEW conversations, decoupled from the legacy
   semantics; deferred here because it breaks zero-loss adoption + mixed-fleet convergence
   for the existing corpus.
10. **Registry compaction/GC** — bounded-by-usage; never deletes (identity resolves
    forever). The §3.4 snapshot+append-journal / SQLite escape hatch is the planned scale
    migration, tracked here so 100k entries is a scheduled move, not an incident.

## Frontloaded Decisions

1. **Minted numeric id over typed-union** — §2, evidence-forced (168 files, 3 SQLite
   INTEGER schemas, deployed negative-id convention, zero-loss skew requirement).
2. **Legacy hash as deterministic mint candidate; probe direction DOWN (`id -= 1`),
   FROZEN forever; alias ids count as occupied during a probe** — §3.3.
3. **Identity = structured tuple `(platform, channelId, threadTs)` + minted id; the
   canonical key is its normalized lookup string; workspaceId is upgradable metadata,
   never the identity core** — §3.1.
4. **Thread identity = resolveRoutingKey verbatim** — §3.2 (a new thread on an old message
   is a new conversation at first reply); threadSessions mode-flip surfaces a deduped
   operator notice when open commitments exist.
5. **`_`→teamId upgrade in place, triggered ONLY by the local authenticated adapter,
   never by replicated data** — §3.1.
6. **Cross-machine identity = the structured tuple, not the key string; same-tuple/`_`-vs-
   real teamId is a metadata upgrade (never a seize); same-tuple/different-id auto-resolves
   by lower-HLC + alias; different-tuple/same-id is refused; aliases are LOCAL-only, never
   ingested** — §3.5.
7. **Replicated entries are advisory until locally corroborated; delivery resolves ONLY
   local-origin entries; every locally-bound entry is copied into the local origin
   (adopted-replicated) so un-merge can't orphan it** — §3.5.
8. **Auto-resolution is a NAMED per-kind departure from the foundation's operator-conflict
   contract (convergent semantics, no judgment call); the foundation's conflict surface is
   suppressed for this kind** — §3.5.
9. **Fail toward delivery on every registry failure; the funnel non-delivery is a typed,
   non-exceptional return (NEVER thrown, NEVER success-shaped, dryRun included), and the
   beacon re-arms + escalates on it** — §3.6, §5.1.
10. **Reachability-floor / resource-denial notices use a gate-EXEMPT deterministic Slack
    arm** (never the fail-closed tone gate) — §5.
11. **The funnel carries the per-conversation notification budget (P17) + permanent-error
    classification; a mint-rate breaker bounds durable growth (Bounded Blast Radius)** —
    §3.3, §5.2.
12. **Foundation + eager mint ship LIVE (behavior-identical); delivery changes ride the
    dev-gate + dryRun-first ladder; replication rides the dev-gated dryRun-first-then-
    dryRun:false ladder; migrateConfig NEVER materializes the `enabled` keys** — §9. (Run
    boundary = post-increment-8; the fleet `followThrough` flip is a post-soak operator
    action, NOT mid-run.)
13. **Commitments + PromiseBeacon are the first proof consumer; order fixed** — §6.1.
14. **Transport sessionKeys unchanged; registry is a join table** — §2/§6.
15. **`/telegram/reply` refuses negative ids (400, assigned to the funnel increment,
    classified terminal in relay/DFS); TopicMemory dual-write keys on the resolved
    conversation id going forward (pre-existing thread rows stay channel-attached,
    accepted)** — §5, §6.0 #16.
16. **Recovery order: backup-restore primary → journal replay → deterministic re-mint
    last-resort (documented probe-order risk); audit-log retention exceeds backup cadence**
    — §6.2, §8.

## Open questions

*(none — both prior entries were non-goals already tracked in §11.4 (Slack attention ack
UX → Phase 2.3) and §11.2 (Phase-2.2 ledger keying); relocated there, no live user-decision
remains.)*
