---
title: "Durable, Channel-Agnostic Conversation Identity (the Phase-1 structural refactor): Spec"
slug: "durable-conversation-identity"
author: "echo"
status: "draft"
parent-principle: "Structure beats Willpower — durable identity must be a registry, not a convention three copies of a hash function remember"
sibling-principles: "The Agent Is Always Reachable — A Guaranteed Reachability Floor; Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions; Know Your Principal — An Unverified Identity Is a Guess; A Refusal Stays a Refusal; Bounded Notification Surface (P17); Migration Parity; Close the Loop (Untracked = Abandoned); Bounded Blast Radius"
lessons-engaged: "Structure beats Willpower (one registry, not three hashes) · Maturation Path — Every Feature Ships Enabled on Developer Agents (§9 dev-gated ladder) · The Agent Is Always Reachable, corollary 2 (§5 deterministic reachability arm) · A Refusal Stays a Refusal / P18 (§5 dryRun returns typed non-delivery, never success-shaped) · Bounded Notification Surface P17 (§5 funnel per-conversation budget + burst test) · Bounded Blast Radius (§3.3 mint-rate breaker) · Cross-Machine Coherence (§3.5 local-origin adoption; §5 owning-machine delivery) · Know Your Principal (§7 replicated entry is advisory, never delivery authority) · Migration Parity (§9 migrateConfig never materializes enabled:false; migrateClaudeMd) · Deferral = Deletion / Close the Loop (§11 Phase-2.1 tracked) · P7 LLM-Supervised Execution (§6.2 Tier 0 justified) · P14 Distrust Temporary Success (§3.3 birthday math honest; §6.2 journal-replay rebuild) · Convergent Merge Algebra — the merge is a pure function of the record set (§3.5.1 collision-class canonical reservation; content-deterministic HLC compared value never clamped; atomic idempotent winner-flip; key-derived probe sequence) · Disaster-Recovery Completeness (§6.2 both the JSON snapshot AND the journal enter the backup manifest — the disk-loss hole closed) · Ambiguous-Outcome Idempotency (§5 id<0 per-conversation logical-send-identity dedup ships WITH the funnel; window ≥ beacon cadence as a stated invariant) · Reuse over Re-implementation (§3.5/§4 shared foundation hardening primitives — no third hand-rolled copy of clamp/HLC) · Runtime Kill-Switch (§9 recording.enabled off-switch honors the CommitmentTracker freeze precedent)"
parent-spec: "docs/roadmaps/instar-two-goal-roadmap-2026-07.md (Phase 1); docs/audits/slack-ai-employee-audit-2026-07.md (§2 root gap, P0-1); docs/audits/mm-current-state-2026-07.md (P1-1)"
depends-on: "SlackAdapter routing keys (src/messaging/slack/SlackAdapter.ts:433-440 resolveRoutingKey — the thread⇄channel identity rules this spec adopts verbatim); the §10.5 conversation-key scheme (src/core/slackRefreshBinding.ts — SLACK_CONVERSATION_KEY_PREFIX + slackRoutingKeySyntheticId, the deployed precedent this spec extends rather than replaces); multi-machine replicated-store foundation (docs/specs/multi-machine-replicated-store-foundation.md — the replication vehicle; the conversations store is a BESPOKE store keyed on the minted id doing its own tuple-first merge, NOT a standard ReplicatedStoreReader consumer, so it needs ZERO foundation change — precedent TopicPinReplicatedStore.mergeUnionToPins §3.5); the session-pool string sessionKey space (src/core/SessionRouter.ts:55 — deliberately NOT changed); CommitmentTracker + PromiseBeacon (the first proof consumer)"
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
| **Structured tuple** | `(platform, channelId, threadTs?)` — the **Phase-1, schema-version-1, SINGLE-WORKSPACE** identity core (workspace-INdependent only because exactly one workspace is enforced, §3.1). This, not the key string, is what the registry uses to decide "same conversation" on ingest (§3.5). Becomes `(platform, workspaceId, channelId, threadTs?)` at schema-version 2 in Phase 7.1 (multi-workspace) — so a reader must NOT treat the v1 tuple as a general cross-workspace identity model. | Immutable once minted; schema-versioned. |
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
- **Upgrade authority (KYP — security-M3(a); reconciles with §3.5 "concrete wins"):** the
  in-place `_`→teamId upgrade is triggered ONLY by the LOCAL adapter's authenticated
  `getWorkspaceId()` — NEVER by replicated data, NEVER by message content. **The §3.5 rule
  "concrete teamId wins over `_`" is therefore scoped to a LOCALLY-SOURCED concrete value
  ONLY.** A replicated entry that carries a concrete teamId on a tuple this machine holds as
  `_` is at most **advisory/corroborating** — it is NEVER applied in place to rewrite the
  local workspace, and if its concrete teamId *differs* from this fleet's pinned workspace
  (below) it is **quarantined-aside + one deduped attention item**, never a silent in-place
  apply. This closes the identity-rewrite vector: replication can neither invent nor change a
  local conversation's workspace.
- The `<channelId>[:<threadTs>]` tail IS the adapter routing key — conversion between
  canonical key and transport sessionKey is a pure string operation
  (`parseSlackRoutingKey`, `SlackForwardBridge.ts:31-38`, reused).
- **Phase-1 single-workspace assumption is STRUCTURALLY ENFORCED, not just documented
  (codex-X2a, codex-R4-1).** This phase supports exactly ONE Slack workspace per fleet, and
  relies on Slack channel-id uniqueness within that workspace for the tuple's `channelId` to
  be a sufficient identity. To ensure a durable equivalence class can never encode the WRONG
  merge (which a later `workspaceId`-in-identity migration would then have to un-tangle), the
  registry **hard-refuses to mint for a SECOND distinct CONCRETE `workspaceId`**.
- **The workspace pin is a FLEET-CONSISTENT value, NOT "first concrete teamId seen locally"
  (A6 — a per-machine first-seen pin can diverge, so one machine would refuse a mint another
  accepts, breaking convergence).** The pin resolves in this fixed order, identical on every
  machine:
  1. **Config-declared** `conversationIdentity.workspacePin` (a concrete teamId in
     `.instar/config.json`) is authoritative when present — the deterministic, coordination-
     free source.
  2. **Absent config**, the pin is a **replicated single-writer fleet value** stored as
     `workspacePin` in the registry file and emitted through the SAME dark/dev-gated
     replication channel (§3.5); the first machine to observe a concrete teamId writes it,
     and it replicates as a single-origin record (a later divergent concrete teamId from a
     peer is quarantined + attention, never a second pin). **A purely-REPLICATED pin never
     fail-closes a machine on its own (R2-security-NEW-2 — first-writer would otherwise be
     attacker-controlled: a compromised peer forging a pin for a teamId the operator doesn't
     own could win the race and make every legit machine refuse all concrete mints, a fleet
     DoS).** Before a machine REFUSES a mint against a replicated-only pin, that pin must be
     CORROBORATED by ≥1 LOCAL authenticated `getWorkspaceId()` observation; and a
     locally-authenticated concrete teamId always takes PRECEDENCE over a purely-replicated,
     never-locally-corroborated pin (the same KYP posture as the rest of §3.5 — replicated is
     advisory, never authority). A replicated pin contradicting the local authenticated teamId
     is quarantined + ONE deduped attention item ("workspace pin conflict — check
     `conversationIdentity.workspacePin`"), and the machine keeps minting under its LOCAL
     authenticated teamId. The config-declared `workspacePin` (source 1) is the
     strongly-preferred deployment path precisely because it removes this race entirely.
  3. A machine that has neither a config pin NOR a confirmed replicated pin, yet observes a
     concrete teamId, **FAILS CLOSED**: it may mint `_`-placeholder ids (which upgrade later)
     but **refuses to mint a CONCRETE-workspace id** until the fleet pin is confirmed — so two
     machines can never independently pin two different workspaces.
  A mint whose authenticated `getWorkspaceId()` returns a concrete teamId DIFFERENT from the
  confirmed pin is refused with a typed `multi-workspace-unsupported` error + ONE deduped
  attention item (a Slack Connect shared channel arriving from a foreign workspace hits the
  same refusal). `_`-placeholder mints are always allowed LOCALLY (they upgrade in place to
  the pinned teamId once it is confirmed) — **but a `_`-placeholder entry REPLICATED from a
  peer is held OUT of the same-tuple cross-machine merge until the fleet pin is confirmed
  (codex-R2-2): before pin convergence, two machines could be authenticated to DIFFERENT
  workspaces, and the same `(platform, channelId, threadTs)` under `_` on both sides would
  otherwise merge two genuinely different conversations. Held entries are advisory-only
  (which costs nothing — replicated entries carry no delivery authority anyway, §3.5) and
  join the merge the moment the pin confirms.** So multi-workspace / Slack Connect is not a silent
  hazard — it is a loud, typed refusal until the Phase-7.1 migration re-enters `workspaceId`
  into the identity core (tuple **schema-version 2**, §Glossary) with a real migration/alias
  story. The tuple-first merge rule here is thereby CORRECT BY CONSTRUCTION within the one
  enforced workspace, not merely by assumption.

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
mint(key, { durableBinding }):
  existing = registry.byTuple(tuple(key))    → return existing.id          (idempotent, O(1) tuple index §3.4)
  id = candidate(routingKey(key))
  probes = 0
  while candidateCollides(id, tuple(key)):                                 (probe DOWN)
    id -= 1; if (++probes > MAX_PROBE_DISTANCE) → typed mint-failure → §3.6 pending-mint path
  assign { key, tuple, id, … } to the authoritative in-memory cache + reverse + tuple index (sync)
  if (durableBinding OR probes > 0):                                       (WAL — see below)
    append one journal line to <stateDir>/logs/conversation-registry.jsonl (the §3.4
    journal-path PIN) through the SINGLE-WRITER journal serializer (§3.4 G3) and fsync
    BEFORE returning id
  schedule the batched full-store snapshot write (off the hot path)
  return id
```

- **The probe target is a PURE FUNCTION OF THE ROUTING KEY, not of live local occupancy
  order (A3/A4 — the convergence lever), and the local mint applies the FULL §3.5.1
  displacement rule, step 2(b) included (R2-adversarial-2).** `candidateCollides(id, t)` is
  true iff ANY of:
  (a) `id` is RESERVED for a DIFFERENT tuple — i.e. `id === candidate(routingKey(other))` for
  some other live tuple `other` (each tuple's canonical `candidate` is reserved for that tuple
  ALONE);
  (b) `id` sits in the alias table (decision-completeness-D4 — a fresh mint never lands on an
  alias id, preserving the one-hop invariant); OR
  (c) `id` is a displacement offset ALREADY TAKEN by a `≺`-earlier displaced tuple of the SAME
  collision class — §3.5.1 step 2(b) applied locally. The registry maintains, per collision
  class (per shared `cand` value), the live set of taken displacement offsets; two tuples
  colliding at one candidate therefore probe to DISTINCT ids locally, in exactly the assignment
  §3.5.1 would compute (without (c), both would probe to the SAME next id and the local
  reverse index would be silently overwritten — cross-conversation mis-resolution on a SINGLE
  machine, before any replication).
  It is **NOT** made true merely because a *probed* peer entry happens to occupy `id` via a raw
  occupancy check (that would re-introduce the Round-1 occupancy-dependent-probe HIGH): a
  probed entry never squats another tuple's canonical id (§3.5.1), so the walk-down sequence a
  machine follows is the frozen offset sequence `candidate, candidate-1, candidate-2, …`
  filtered ONLY by the reserved canonicals + the alias table + the `≺`-ordered taken-offset set
  of its own collision class — each a pure function of the tuple set that every machine
  computes identically. **§3.3 local mint and §3.5.1 merge step 2 MUST share ONE implementation
  of this displacement rule (a single exported function), pinned by a §10 equivalence test**
  (the same tuple set fed to the local prober and to the merge yields byte-identical
  assignments). **Each check in `candidateCollides` is O(1) — a reverse-index/reserved-canonical
  lookup, an alias-table lookup, and a bounded per-class taken-offsets set (≤ MAX_PROBE_DISTANCE
  entries) — NEVER a live-tuple scan (R2-scalability-1);** §10 extends the no-linear-scan
  assertion to the probe path. The local mint is thereby **provisional-but-convergent**: it is
  the value used for immediate local delivery, and under replication the deterministic §3.5.1
  merge is the authority — a local id that disagrees with the merge's canonical assignment
  becomes a one-hop alias, never a divergence.
- **Probe direction is DOWN (`id -= 1`) and is FROZEN FOREVER** (frontloaded decision 2).
  Rebuild determinism (§3.3 property 3), the §3.5.1 merge, and cross-machine convergence all
  require every implementation, on every version, to probe identically.
- **The local probe loop is BOUNDED by the SAME `MAX_PROBE_DISTANCE = 64` the ingest
  coherence check uses (§3.5)** — scalability-N2. This is a hard invariant: a local mint may
  NEVER produce an id further than 64 below its candidate, because every peer's ingest would
  quarantine such an entry as a suspected pre-squat (local-probe-distance ≤ ingest-bound). A
  probe overflow (astronomically unlikely — 64 consecutive occupied ids near a random point
  in a 2³¹ space) degrades to the §3.6 pending-mint path, never a silently-un-ingestable id.
- **The WAL rule (codex-R3-1, scalability-N1, adversarial-A, security-1 — four-reviewer
  convergent).** The id is assigned synchronously in-memory (so `returned == will-persist`
  for in-memory reads), but "persist THEN return" is realized on the DURABILITY axis by a
  cheap append+fsync of ONE journal line — NOT the O(N) full-store JSON write, which stays
  batched. This synchronous journal append is REQUIRED (before the id is handed to a
  consumer that will durably bind to it) for two cases where the id is NOT deterministically
  re-derivable after a crash: (a) a **probed** id (probe order is lost if only the batched
  snapshot carries it), and (b) any **durable-binding-forced** mint (§3.3 breaker carve-out —
  a commitment/working-set bind). §6.2 journal replay then restores these across a hard
  crash in the assign→snapshot window. A pure SPECULATIVE, non-probed inbound mint needs no
  synchronous write (its candidate re-mints deterministically for free on the next inbound),
  so it rides the batched snapshot only — no whole-file write on the hot path, the §3.4
  freeze pattern is never reintroduced.

Why the legacy hash is the candidate — three load-bearing properties:

1. **Zero-loss adoption — scoped honestly (codex-R3-2).** The claim is proven ONLY for
   CHANNEL-LEVEL ids, which is all that durable stores actually hold today: the sole durable
   negative-id writer before this spec is the TopicMemory dual-write (`server.ts:13216-13227`),
   which hashes the bare **channelId** (channel-level), and the boot adoption pass (§6.2)
   re-mints exactly those channel-level keys from `slack-channel-registry.json` → same id,
   history attaches. **Inventory of durable stores that can hold negative ids:** TopicMemory
   (channel-level, adoption-covered); PresenceProxy state (in-memory, non-durable — nothing
   to adopt); the §10.5 SessionRefresh binding (thread-aware, but session-resume state, not a
   durable follow-through consumer). **Thread-level ids are NOT claimed zero-loss**: no
   durable store holds one today (Slack follow-through does not exist yet — that is what this
   spec builds), and any future thread-level id is re-minted deterministically on its next
   inbound (its routing key reappears) OR restored by journal replay if it carried a durable
   binding (the §3.3 WAL rule). The one-way hash means a durable thread-level id with NO
   journal entry and NO future inbound is unrecoverable — which is exactly why the WAL rule
   fsyncs the journal line before a thread-level binding commits.
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
| ~1,000 (channel-default, small org) | ~0.02% |
| ~10,000 | ~2% |
| ~55,000 | ~50% |
| ~100,000 (threads-enabled, busy org over time) | ~90% |

Every determinism claim in this spec is therefore scoped **"absent probes."** A probe is
NOT a data-loss event by itself (the registry assigns a fresh id and records it); the
danger is ONLY a rebuild that replays probes in a different order (§6.2 closes it via
journal replay). A wider candidate space (48-bit, within negative-safe-integer range) is
available for FUTURE thread-level mints if scale demands — deferred here because it breaks
zero-loss adoption and mixed-fleet skew convergence for the existing corpus; §11 tracks it.

**The birthday table above assumes a UNIFORM hash — but the frozen djb2-style sum-shift is
NOT proven uniform over short, shared-prefix Slack ids (F3).** Real Slack channel ids
(`C0BA…`) and thread ts share long prefixes, and the hash is frozen forever, so measured
clustering could exceed the table's predicted band and make probes commoner than modeled.
This is not left to hope: §10 pins a **Tier-1 STATISTICAL test with real statistical power
(R2-scalability-3 — a "thousands"-sized corpus expects <1 collision, so any measured count
"within band" is a tautology).** The test either (a) mints near the 50%-knee (~55k real-shaped
Slack channel + thread ids) and asserts the measured collision count within the birthday
band, or (b) applies a **chi-square / bucket-occupancy uniformity metric** over the hash
outputs of a smaller corpus (which detects clustering without needing collisions to
materialize). A material overshoot / non-uniformity verdict is the concrete TRIGGER to
bring the wider (48-bit) candidate space forward for new thread-level mints (§11.9) rather
than defer it — the measurement, not a guess, decides.

Collision safety with real Telegram topic ids is **structural**: minted ids are always
`< 0`; Telegram `message_thread_id` values are always `> 0`. The registry validates
`id < 0` on every write and every replicated ingest (type-clamp). `0` is unmintable
(`-(abs+1)` ≥ 1 in magnitude).

**Mint-rate breaker (Bounded Blast Radius — adversarial-A4, security-m2).** Mint is gated
behind authorized senders (verified fail-closed, `SlackAdapter.ts:150-157,992-995`), but
any authorized sender, a looping bot, or a channel-rename/thread-flood storm can drive
unbounded durable entries. A per-channel, per-window mint budget sits at the mint
chokepoint, with a critical carve-out (scalability-F1, adversarial-A4-drain). **Pinned
defaults (so the build needs no user input; all under `conversationIdentity.mintBreaker`,
existence-checked in `migrateConfig`):** `windowMs = 600000` (10 min); `speculativePerWindow
= 200` distinct new speculative registrations per channel per window; `durableBindingPerWindow
= 50` per channel per window (a SEPARATE, dedicated budget for the forced-registration bypass
below — not drawn down by the speculative flood, so a real durable binding still registers
even when the speculative budget is exhausted; 50/channel/window is already extreme for
durable bindings); `deadLetterAttentionAfter = 1` (a single deduped attention item per episode):

- **A durable BINDING forces registration — but the bypass carries its OWN cap
  (adversarial-B; "guard bypass carries its own cap").** When a consumer binds durable state
  to a conversation (opening a commitment, a working-set carry — the paths that need
  `resolve(id)` to work after a restart), the mint is registered REGARDLESS of the speculative
  budget, AND the WAL rule (§3.3) fsyncs its journal line first. Because forcing registration
  is itself an escape hatch around the growth breaker, it gets its OWN separate, HIGHER
  per-window budget with a defined TERMINAL behavior at the cap: a typed refusal on the
  binding-open (`POST /commitments` returns a typed "conversation-registration-capacity"
  error the session surfaces) + ONE deduped attention item — NEVER a silent drop (a drop would
  reopen the lost-`resolve` hole). Reaching this cap is extreme (durable bindings are far
  rarer than inbound messages, and mint is authorized-sender-gated fail-closed +
  `POST /commitments` is Bearer-gated), so it is a loud backstop, not a normal path.
- **The breaker only defers SPECULATIVE inbound-triggered registrations, and defers them to
  NOWHERE — it DROPS them (zero pending state).** The candidate id is deterministic and
  recomputable from the routing key, so a dropped speculative registration re-mints for free
  on a later inbound (once the window resets) or via the boot adoption pass. There is no
  in-memory pending set to grow under the flood (the failure mode the breaker exists to
  prevent — Bounded Blast Radius on the memory axis, not just the disk axis).

Over-budget conversations STILL DELIVER (identity never costs a message) — but delivery uses a
**collision-checked read, never a raw candidate (B6).** Before delivering on the in-memory
candidate id, the degraded path consults the live **id→key reverse index**: if the candidate is
occupied by a DIFFERENT tuple, delivery uses the same key-derived probe resolution (§3.5.1) for
the READ ONLY (it does not register a new durable entry) so it never cross-delivers into another
conversation; only if the candidate is free/its-own does it deliver on the raw candidate. ONE
deduped attention item names the episode. `GET /conversations/health` surfaces the entry count
and file size with a threshold attention item (the tripwire before the §3.4 growth cliff).

### 3.4 Storage

`state/conversation-registry.json` — house-style JSON store: atomic tmp→rename writes,
single-writer serialized `mutate()` (the CommitmentTracker/TopicProfileStore CAS
pattern), in-memory cache authoritative for reads, corrupt-file quarantine-aside with the one
deduped attention item (the TopicPlacementPinStore pattern). **Two in-memory indexes are
maintained SYNCHRONOUSLY at assign time (same tick as the id assignment), so the hot path is
O(1) with no O(N) scan (scalability-G1):** (1) an **id→key reverse index** (replacing the old
`slackProxyChannelMap`) for `resolve(id)`; (2) a **tuple→entry index** `Map<tupleKey, entry>`
(`tupleKey = platform + '\x1f' + channelId + '\x1f' + (threadTs ?? '')`) for mint idempotency
(`byTuple`) and same-tuple detection on EVERY inbound — a faithful implementer must NOT realize
these as a scan of `conversations`. §10 pins a Tier-1 assertion that `byTuple`/same-tuple
detection perform no linear scan. Entry shape:

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
      "mintedBy": "<machineId>",         // OVERWRITTEN to the AUTHENTICATED replication-envelope
      //   origin on ingest (never trusted from the wire, exactly like `origin`) — the alias
      //   tiebreak & any HLC node key on THIS value, so a forged mintedBy cannot move a winner (B4)
      // origin is LOCALLY assigned, NEVER a peer-supplied/clamped field: a peer entry is
      // written as "replicated" on ingest and only upgraded LOCALLY to "adopted-replicated"
      // on first corroboration. deliverToConversation resolves ONLY the three local origins.
      "origin": "adopted-legacy-hash" | "minted-probed" | "adopted-replicated" | "replicated",
      "reachability": "ok" | "unreachable",   // LOCAL-authoritative delivery state (§5.1); enum-clamped on ingest; a replicated value is display-only + NEVER drives the owner's dead-letter (security-2)
      "sticky": false,                    // durable-binding marker (R2-adversarial-1): set true (journaled +
      //   replicated) when a durable consumer binds to this id; a sticky id is NEVER demoted by the
      //   §3.5.1 merge; boolean-clamped on ingest, monotonic (replicated false never clears local true)
      "hlc": { "physical": 0, "logical": 0, "node": "…" },  // the emitter-ticked record HLC; the §3.5.1 winner-tiebreak clock. Its `physical` is the RAW emitter value — the convergent comparison NEVER reads a clamped/mutated value (A2). Anti-forgery is an ACCEPTANCE check on ingest (out-of-absolute-sanity-window ⇒ quarantine), not a mutation of the compared field.
      "label": "#engineering"            // display-only, refreshable, UNTRUSTED peer data — neutralized/escaped at EVERY sink (§3.5 B3), or excluded from that sink
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
- Delivery never waits on the O(N) full-store WRITE — but the id is assigned SYNCHRONOUSLY
  and its DURABILITY is anchored by a cheap journal append (the WAL model, §3.3). The mint
  assigns the id against the authoritative in-memory cache + id→key reverse index, **probe
  included** (O(1) synchronous ops), so the id RETURNED always equals the id that will
  PERSIST — no misdelivery window, never a raw pre-probe candidate. **A probed or
  durable-binding-forced mint additionally append+fsyncs ONE journal line to
  `logs/conversation-registry.jsonl` BEFORE the id is handed to the durable consumer**
  (codex-R3-1/scalability-N1/adversarial-A/security-1: the ids that are NOT deterministically
  re-derivable after a hard crash — probed ids lose their order, forced bindings may be
  thread-level — must be on disk before a commitment binds to them; §6.2 replay restores
  them). The journal append is O(1) (append-only line), NOT the O(N)
  `JSON.stringify`+`writeFileSync` that caused the freeze — so this reintroduces NO whole-file
  write on the hot path. Only the full-store `saveStore()` SNAPSHOT is deferred/batched;
  `mutate()` is used purely for the snapshot, not for id assignment. Queue overflow (the
  CommitmentTracker `MUTATE_QUEUE_MAX_DEPTH=256` precedent) degrades to the §3.6 pending-mint
  path. Returning a raw candidate BEFORE synchronous assignment is reserved strictly for the
  registry-*unavailable* path (§3.6), whose heal repairs the affected binding's id FORWARD —
  never by aliasing onto a live foreign id (which §3.5 would refuse anyway).
- **Snapshot cadence is SIZE-ADAPTIVE (scalability-G2).** Batching cuts snapshot FREQUENCY,
  but each flush is still an O(N) full-store `JSON.stringify`+write — the CommitmentTracker
  freeze SHAPE, just periodic. So the batch interval BACKS OFF as `entryCount` grows
  (`flushIntervalMs = clamp(baseIntervalMs × ceil(entryCount / adaptiveStep), baseIntervalMs,
  maxIntervalMs)`; pinned defaults `baseIntervalMs = 2000`, `adaptiveStep = 5000` entries,
  `maxIntervalMs = 60000`) so `per-flush-stall × frequency` stays bounded as the store grows.
  **Event-loop honesty (R2-scalability-4):** the batched flush itself still executes an O(N)
  `JSON.stringify`+write on the SHARED event loop — so the "delivery never waits on the O(N)
  write" claim is scoped precisely to the MINT HOT PATH (id assignment + journal append),
  never to the process as a whole. At the upper envelope (entryCount approaching the §3.4
  ceiling) the flush serialization moves OFF the event loop (async write of a pre-serialized
  buffer, or a worker-thread stringify — the cartographer detect-in-worker precedent); the
  §11.10 SQLite migration retires the O(N) flush entirely.
  Metadata upgrades (label refresh, reachability flip, `_`→teamId) are **strictly
  write-on-change (compare-then-write)**: an already-current value schedules NO snapshot, so a
  healthy, unchanging conversation costs zero writes (scalability-G4). `reachability` also
  auto-clears to `ok` write-on-change (§5.1), so a re-invited channel does not thrash the store.
- `GET /conversations/health` carries `entryCount` (the resident-heap axis) + `fileSizeBytes`
  with a threshold attention item (design ceiling stated: ~50k entries / ~10MB is the
  JSON-store ceiling). The snapshot-lost replay bound is `O(retained-journal-lines)`, and the
  journal's retained size is capped (§8 rotation) so replay is bounded even at the ceiling.
  Replication-emit volume is a scale axis too: per-entry emits COALESCE within the batched
  window (a burst emits once, not per-entry).
- **Named escape hatch (not deferred silently):** past the ceiling, migrate to
  snapshot + append-journal (the `logs/conversation-registry.jsonl` audit is already half
  of it — make the append-journal the PRIMARY) or SQLite (the pending-relay-store precedent;
  §11.10 / the Rejected-alternative subsection below). §11 tracks it as a planned migration,
  and it MUST land BEFORE the ceiling, not AT it (scalability-G2), so 100k entries is a
  scheduled move, never an incident.

**WAL crash-consistency contract (codex-R4-3 — a recovery-critical journal needs a real
contract, not "append a line").** The journal is the crash-durability write-ahead log; the
JSON snapshot is a rebuildable cache. The contract:
- **Journal path PIN (R2-integration-1 — two log roots exist and the manifest resolver picks
  one).** instar has BOTH `<agentHome>/.instar/logs/` (the StateManager stateDir root) AND
  `<agentHome>/logs/` (the server.log/reap-log/audit convention). `BackupManager` resolves
  manifest entries as `path.join(stateDir, entry)` — so a journal written to `<agentHome>/logs/`
  with a manifest entry `logs/conversation-registry.jsonl` would resolve to a DEAD manifest
  entry and silently re-open the CRITICAL disaster-recovery hole. Therefore the journal lives
  EXPLICITLY at **`<stateDir>/logs/conversation-registry.jsonl`** (i.e. `.instar/logs/…` —
  the stateDir root, NOT the agent-home log root); the backup manifest entry is the
  stateDir-relative **GLOB `logs/conversation-registry.jsonl*`** (capturing rotated files);
  and a Tier-2 test asserts the manifest entry **resolves to a REAL file on disk** after a
  mint — never just a string present in `includeFiles` (§10). Every reference to the journal
  in this spec means this pinned path.
- **Record framing:** each journal line is ONE self-contained JSON object
  `{ seq, op: "mint"|"alias"|"reachability", key, tuple, id, origin, hlc, ts }` terminated by
  a newline. `seq` is a per-file monotonically-increasing sequence number. A reader tolerates
  a **torn tail** (a crash mid-append): the last line lacking a terminating newline OR failing
  JSON parse is DISCARDED (only a fully-written, newline-terminated line is a committed
  record). No line is ever rewritten in place (append-only), so an earlier record can never be
  corrupted by a later crash.
- **Append serialization — the journal has its OWN single-writer discipline (scalability-G3).**
  The serialized `mutate()` (§3.4 above) is scoped to the SNAPSHOT; it does NOT cover journal
  appends, so two probed/durable mints in the SAME tick could otherwise interleave `seq`
  assignment and byte-writes and defeat the torn-tail rule (which tolerates only ONE unterminated
  TAIL line — an interleaved half-written NON-tail record would be unrecoverable). Therefore
  journal appends go through a DEDICATED single-writer path: `seq` is assigned and the full
  newline-terminated line is written atomically per record under a synchronous append (an
  `appendFileSync` guarded by an append mutex, or a serialized append queue drained one record
  at a time). §10 pins a Tier-1 test: concurrent probed + durable mints in one tick produce
  strictly monotonic `seq` and never an interleaved/torn NON-tail record.
- **fsync discipline:** the durable-binding/probed append fsyncs the FILE; on file
  creation and on rotation the containing DIRECTORY is fsynced once (so the new/rotated file's
  directory entry is durable). Speculative non-probed mints do not fsync (they ride the batched
  snapshot).
- **Snapshot high-water mark:** the batched JSON snapshot persists the highest `seq` it
  incorporated (`snapshotHighWaterSeq`). Recovery loads the snapshot, then replays ONLY journal
  records with `seq > snapshotHighWaterSeq` — so replay is bounded (never the whole journal) and
  the snapshot + tail compose to the exact pre-crash state.
- **Idempotent replay:** replay is keyed by `id`/`tuple`; re-applying a record already present
  (from the snapshot or an earlier replay) is a no-op. Replay is therefore safe to run any number
  of times, and a crash DURING replay simply re-runs it.
- **Rotation/checkpoint:** the journal rotates by size/line cap (§8) — pinned default
  `journalRotateBytes = 8388608` (8 MB) — with retention exceeding the backup cadence; a
  rotation writes a fresh file whose first record carries the current `snapshotHighWaterSeq` as
  a checkpoint anchor, and prunes only fully-superseded rotated files (every record ≤ a
  persisted snapshot's high-water). This is the incremental adoption of the §3.4 "snapshot +
  append-journal" escape hatch — shipped NOW for the durable path, not deferred.

**Backup manifest — the SNAPSHOT AND THE JOURNAL, both (gemini-C1 CRITICAL).** Disk-loss (the
2026-06-26 kernel-panic class) is the ONLY case where backup IS the recovery path, and it takes
BOTH the live `state/conversation-registry.json` AND the WAL. The WAL is the sole durable record
of **probed ids and thread-level durable bindings**; if only the JSON snapshot were backed up, a
disk-loss restore would silently lose every probed/thread-level id minted since the last snapshot
flush — reopening the exact hole the WAL exists to close. Therefore the backup manifest carries
BOTH: `state/conversation-registry.json` AND the stateDir-relative journal GLOB
`logs/conversation-registry.jsonl*` (the §journal-path pin — the glob captures the live file
plus rotations within retention) in `config.backup.includeFiles`.

**No pre-backup flush hook (R2-integration-2 — DROPPED).** An earlier draft required a
synchronous `saveStore()` flush immediately before each backup run. That requirement is
REMOVED: `BackupManager` has no before-snapshot hook (the mechanism does not exist), and the
flush is REDUNDANT with the WAL-in-backup — a restore is "stale snapshot + journal-tail
replay" by construction (§6.2), so any probed/durable mint that landed after the last batched
flush is captured by the journal glob. Snapshot-consistency at backup time is NOT required;
recovery composes it.

These join `config.backup.includeFiles` via PostUpdateMigrator exactly as
`state/topic-profiles.json` + `state/topic-operators.json` did
(`PostUpdateMigrator.ts:8905-8944` — durable identity class; stateDir-RELATIVE path
shape per the pinned round-6 lesson). A Tier-2 test asserts the backup manifest contains BOTH
entries AND that each resolves to a REAL file on disk after a durable mint (§10). **Backup restore is the PRIMARY disaster-recovery path** (gemini-G2); journal
replay (§6.2) is the secondary; deterministic re-mint is the last resort with the documented
probe-order risk.

### 3.5 Multi-machine replication semantics — a BESPOKE store, not a standard consumer

**Posture declaration (Cross-Machine Coherence — mandatory).** The registry is
**machine-local at the mint site** (the owning/serving machine mints) and **replicated as
a dark, dev-gated store** (`multiMachine.stateSync.conversations`, §9). Delivery
resolution is **owning-machine-authoritative** (§5). A single-machine agent is a strict
no-op.

**The conversations store is a BESPOKE replicated store that does its OWN merge — it is
NOT a standard `ReplicatedStoreReader`/`UnionReader` consumer** (the round-2 convergent
finding: three reviewers independently established that the foundation offers exactly two
impact tiers — `high` = preserve-both + operator `conflictId`, `low` = HLC-MAX-wins — and
"there is no third 'silent' tier by construction; every concurrent resolution is
surfaced" (`UnionReader.ts:49-52`), with `ReplicatedStoreReader.read` recording the
conflict UNCONDITIONALLY (`:117-121`). There is NO per-kind "auto-resolve + suppress the
conflict surface" hook, and adding one would change shared code all 7 deployed WS2 stores
traverse). The precedent is `TopicPinReplicatedStore.mergeUnionToPins`
(`TopicPinReplicatedStore.ts:141-166`): a store that reads envelope-validated per-origin
records and merges them ITSELF, never touching `readUnion`/`ConflictStore`.

**The replication record is keyed on `(origin, id)` — the per-origin envelope namespace,
made PRECISE (codex-R2-1: keying on the bare id would let two origins claiming the SAME id —
the valid different-tuples/same-candidate collision case, pre-merge — share one recordKey and
enter the foundation conflict path this section claims to avoid).** Each machine emits its
records into its OWN origin namespace (the standard per-origin record layout the foundation
already replicates); the bespoke merge consumes the per-origin envelopes DIRECTLY (before any
union), so two origins' records claiming the same id are two distinct `(origin, id)` records
by construction — the foundation never sees a key collision, and §3.5.1 resolves the winner.
The record is NOT keyed on the tuple and NOT on the key string. Consequence:
same-tuple/different-id (the only real
divergence — a probe on one side) arrives as TWO DISTINCT recordKeys that NEVER enter the
foundation conflict path. **Claimed vs resolved is likewise explicit (codex-R2-3): the raw
`(origin, id)` records are CLAIM inputs held as-received; the live `id→key` reverse index and
`resolve()` read ONLY the DERIVED §3.5.1 assignment output — never a raw record's claimed id —
so two accepted records claiming the same id coexist harmlessly as claims while the pure merge
recomputes the winner.** The conversations store detects the same-tuple pair in its OWN
tuple index and writes the LOCAL alias entirely ABOVE the foundation — **zero foundation
change, no conflict surface to suppress** (that framing is dropped). Winner selection is a PURE FUNCTION OF THE RECORD SET (§3.5.1), so both machines compute the
identical result regardless of arrival order or receiver clock:
- **The tiebreak clock is the record-carried EMITTER HLC, read RAW — never clamped, never
  mutated (A2).** There is ONE HLC per record: the emitter-ticked value carried in the
  replication record's `data`, persisted as the entry's `hlc` field (§3.4). The convergent
  comparison reads that raw `physical`/`logical`/`node` — it must be **content-deterministic**,
  so it is NEVER replaced by a receiver-relative value. A receipt-relative clamp (an online
  receiver vs an offline-then-returning receiver would compute DIFFERENT clamped values for the
  same record and could pick different winners → non-convergence) is therefore forbidden on the
  compared field. Anti-forgery is folded into ingest ACCEPTANCE instead: a record whose HLC
  `physical` falls outside a **FIXED ABSOLUTE sanity window** (`HLC_ABS_MIN` … `HLC_ABS_MAX` —
  frozen constants identical on every machine; e.g. `physical ≤ 0` or `physical` beyond a far-
  future absolute bound) is **quarantined-aside on ingest**, not applied — so a forged
  `{physical:0}` never enters the comparison at all, and every machine makes the same
  accept/quarantine decision. (The foundation's pool-relative `receive()` skew check still runs
  for local-clock hygiene, but the conversations store's convergent winner selection depends
  ONLY on the raw compared value + the absolute acceptance window, never the pool-relative one.)
- **Lower-HLC winner** (earliest-minted tuple keeps the canonical id), **tiebreak the
  lexicographically smaller machineId — keyed on the AUTHENTICATED replication-envelope origin,
  NOT the peer-supplied `mintedBy`/`hlc.node` field (B4).** `mintedBy` and `hlc.node` are
  overwritten to the authenticated envelope origin on ingest (§3.4 clamp), so a forged
  `mintedBy` or a forged `hlc.node` cannot move a winner. §10 pins the forged-mintedBy test.

The `adopted-replicated` local-origin copy (below) is emitted via the STANDARD
`ReplicatedRecordEmitter` so its `observed` witness ≥ the source entry's HLC (it
witness-dominates and cannot manufacture a spurious self-conflict).

**Hardening is applied by REUSE, never re-implementation (B5 — the parent-principle forbids
a fourth hand-rolled copy of a safety function).** The foundation's clamp/validate/HLC-
acceptance-window helpers are **extracted as shared EXPORTED primitives** (`clampReplicatedRecord`,
`validateEnvelope`, `hlcWithinAbsoluteWindow`) that the bespoke conversations-store ingest path
**MUST call** — it never re-implements them, so a future foundation hardening fix reaches this
store for free. **All ingest normalization routes through ONE shared entry function
(`normalizeConversationsIngest`), which internally invokes those primitives
(R2-lessons-4: a lint can verify INVOCATION of a named function; it cannot verify the
absence of a parallel copy — so the structure makes the single entry point the only path).**
§10 adds a **wiring-integrity/lint assertion** that the conversations-store
ingest path invokes the shared entry function + hardening helpers (a hand-rolled inline clamp
is a CI failure).

**Mint authority: the machine that owns/serves the conversation.** Inbound dispatch on
the owner is the minting site (a synchronous in-memory id assignment — probe included —
against the authoritative cache + id→key reverse index; only the durable `saveStore()`
write is deferred off the hot path, so the id RETURNED always equals the id PERSISTED, no
misdelivery window). Same-tuple concurrent mints are structurally rare; the deterministic
candidate makes even a genuine race CONVERGENT.

**Reused WS2 hardening, applied to this store, PLUS the hardening the security/lessons
round required:**

- **Type-clamp on ingest** (via the shared `clampReplicatedRecord` primitive, B5): `id` must
  be a negative safe integer; `platform` **enum-clamped** to a minted platform (`slack` today;
  never `telegram`, never unknown); `channelId` shape-clamped (`^[CDG][A-Z0-9]+$`), `threadTs`
  shape-clamped (`^\d{10}\.\d{6}$` or null); `key` regex `^slack:[A-Za-z0-9_.:-]+$`;
  `workspaceId` shape-clamped **`^T[A-Z0-9]+$` or the literal `_`** (R2-security-NEW-6 — it was
  absent from the allowlist); `sticky` a strict boolean (R2-adversarial-1, monotonic on merge —
  a replicated `false` never clears a local `true`);
  timestamps ISO-8601-only; `hlc.physical` is **NOT clamped in value** — instead it is
  **accepted-or-quarantined against a FIXED ABSOLUTE sanity window** (`HLC_ABS_MIN` …
  `HLC_ABS_MAX`, identical on every machine), so a forged `{physical:0}` is quarantined on
  ingest rather than mutated into the comparison (A2 — the convergent tiebreak reads the raw
  value); `hlc.node` and `mintedBy` **overwritten to the authenticated replication-envelope
  origin** (never trusted from the wire, B4); `reachability` **enum-clamped `{ok, unreachable}`
  AND treated as LOCAL-authoritative** — a replicated `reachability` is display-only and MUST
  NOT drive the owner's terminal dead-letter (security-2: the owner reads only its OWN
  locally-observed reachability; else a forged `unreachable` could kill a live beacon);
  `origin` is NOT peer-clamped — it is overwritten to `replicated` locally on ingest (never
  trusted from the wire); `label` length-bounded AND treated as **UNTRUSTED peer data at EVERY
  sink, not only render surfaces (B3)** — see the label-sink rule below.
- **The replicated `label` is neutralized/escaped at EVERY sink, or excluded from it (B3).**
  A poisoned peer label must not reach an un-escaped sink anywhere: it is escaped on
  `GET /conversations` (the only Phase-1 render surface — see the dashboard note), and it is
  **excluded from every non-render sink** — attention-item titles/bodies, beacon/notice text,
  and any session-context injection carry the SAFE identifiers (the minted id + the
  locally-derived `channelId`), NEVER the replicated `label` string. §10 pins a test that a
  poisoned replicated label cannot reach an un-escaped LLM/notice/attention sink. **Dashboard
  scope (resolving the §3.4/§3.5 vs §8 ambiguity): there is NO dashboard render surface for the
  registry in Phase 1** — labels render ONLY via `GET /conversations`, which escapes them; a
  dashboard tab is a tracked Phase-2.x follow-up (§11) and inherits the same escape-on-render
  test when it lands.
- **id↔key coherence check (security-M1, adversarial-A3).** On ingest the registry
  recomputes `candidate(routingKey(key))` and accepts the entry ONLY if `id === candidate`
  OR `id` is within a **bounded probe distance** of the candidate. The bound is a FROZEN,
  VERSIONED constant `MAX_PROBE_DISTANCE = 64` (pinned in the module, changed only by a
  versioned migration — a different bound across versions would cause divergent
  accept/quarantine). An entry claiming an id further than the bound from its key's
  candidate is **quarantined-aside + one deduped attention item**, never applied — this
  removes the pre-squat/preimage capture vector (a peer replicating
  `{attacker-key, id=candidate(victim-key)}` with an unbounded fake id). A
  legitimately-probed peer entry WITHIN the bound is ACCEPTED even if this receiver cannot
  yet locally explain the probe: unordered replication can deliver the probed entry before
  the entry occupying the candidate (adversarial-A3 out-of-order), and requiring
  locally-visible occupancy would false-quarantine good data + fire a spurious security
  alert. It errs SAFE — the entry is advisory/non-deliverable until local corroboration
  (below), and the same-tuple/different-id alias rule reconciles it.
- **Cross-machine identity = the STRUCTURED TUPLE** (`(platform, channelId, threadTs)`),
  NOT the key string and NOT a local ordinal. This is the fix for the placeholder-skew
  false-forgery (integration-I1, decision-D1, lessons-F5, security-M3b). The five cases below
  are the informal statement of the formal **merge function (§3.5.1)**, which is the normative,
  pure-function-of-the-record-set authority; every case resolves identically on both machines:
  - **Same tuple, one side's teamId is `_`**: the SAME conversation. Apply as the §3.1
    in-place metadata upgrade — but ONLY the LOCALLY-authenticated concrete teamId performs the
    in-place workspace rewrite (§3.1 B1). A REPLICATED concrete teamId on a locally-`_` tuple is
    advisory/corroborating (and, if it differs from the fleet pin, quarantine + attention), id +
    tuple unchanged — NEVER a seize refusal.
  - **Same tuple, same id, different label/metadata**: normal metadata merge (latest
    non-identity field wins by the raw-HLC compare; label refresh).
  - **Same tuple, DIFFERENT id** (a probe occurred on one side): detected in the store's
    OWN tuple index (both ids are distinct single-origin replication recordKeys — this
    NEVER reaches the foundation conflict path). Deterministic winner = the entry with the
    LOWER raw emitter HLC (tiebreak: lexicographically smaller AUTHENTICATED-envelope
    machineId); the loser id is recorded in the LOCAL `aliases` table resolving to the winner.
    Both machines apply the same rule → convergence. `resolve(aliasId)` returns the winning
    conversation (aliases are followed exactly one hop; the registry forbids alias chains by
    resolving at write time — see the atomic winner-flip below). ONE deduped attention item
    surfaces the episode.
  - **DIFFERENT tuples whose candidates PROVABLY COLLIDE** — `candidate(routingKey(T_incoming))
    === candidate(routingKey(T_local))`, a legitimate hash collision, NOT a hijack (A1, the
    deadlock fix): this is resolved DETERMINISTICALLY FROM THE TUPLE PAIR, never from local
    occupancy. The `≺`-lesser tuple (lower raw emitter HLC, tiebreak the immutable tuple byte-form
    — §3.5.1) keeps the canonical candidate id; the other is forced to the deterministic
    key-derived probe offset (§3.5.1 collision-class reservation). Both machines compute the
    identical assignment from the record set, so the earlier deadlock — where each machine
    quarantined exactly the record it needed to reconcile because it minted the pair in the
    opposite order — cannot occur. This is a merge case, NOT a seize.
  - **DIFFERENT tuple, SAME id, and the candidates do NOT collide** — the claimed id is neither
    the incoming tuple's own `candidate` nor a deterministic collision-probe offset of it
    (§3.5.1): a genuine seize attempt / corrupt entry. REFUSED, quarantined-aside, one deduped
    attention item. Never applied. **The seize-refusal is gated EXACTLY on this predicate** (A1):
    it fires ONLY for an id a different tuple claims that is unreachable as that tuple's canonical
    OR a within-bound collision-probe offset — never on a collision-induced probe (which is the
    case above).
  - **Atomic, idempotent winner-flip (A5) — never against a STICKY id (R2-adversarial-1).** A
    genuinely-lower-HLC record can arrive LATE and demote a settled winner — but ONLY a winner
    with NO live durable binding: an id carrying the §3.5.1 `sticky` marker is NEVER demoted (the
    late colliding record takes the step-2 displacement walk instead), so an id a live commitment
    is bound to can never silently become an alias out from under that binding. For non-sticky
    demotions, the re-point
    is a SINGLE atomic, idempotent-under-replay transaction, journaled as ONE `alias` op: within
    the store's serialized `mutate()`, (1) record `loserId → newWinnerId`, and (2) **re-scan the
    alias table for every alias whose target === the demoted id and re-point it to the new
    winner in the same op** — so aliases never form a chain and a mid-replay crash re-runs to the
    same state. `resolve()` therefore always returns the current winner in one hop, even across a
    winner-flip. §10 pins: three ids for one tuple arriving in every permutation converge to a
    single winner with all losers as ONE-HOP aliases (no chains).
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
- **No departure from the foundation conflict contract is needed (lessons-F7, security-M2,
  integration-F1 — the round-2 convergent fix).** Because the replication record is keyed
  on the minted `id` (single-origin recordKey per id), same-tuple/different-id NEVER lands
  as a foundation conflict — the two ids are distinct recordKeys the foundation replicates
  independently, and the bespoke store detects the same-tuple pair in its OWN tuple index
  and writes the LOCAL alias above the foundation. The foundation's "never picks a winner —
  that is the operator's" invariant is therefore UNTOUCHED (no `conflictId` to suppress, no
  new tier, no shared-code change; the 7 deployed WS2 stores are byte-unaffected). The
  alias is a store-local convergent reconciliation of two independently-minted ids for the
  same real conversation — no data lost, one deduped attention item surfaces the episode.
- **Tombstones**: none. Conversations are never deleted (an id that ever entered a durable
  store must resolve forever). Registry entries are append-only plus in-place metadata
  upgrades (§3.1 teamId backfill, label refresh, reachability).

### 3.5.1 The merge function — a pure function of the record set (A7)

This is the NORMATIVE algebra the informal cases above realize; the external GPT-tier reviewer
asked for it explicitly, because it is what makes A1–A5 implementable identically on every
machine. `resolve()` and the id-assignment are defined so that, given the SAME set of replicated
records `R`, **every machine computes byte-identical output regardless of arrival order, receiver
clock, or local mint order.**

**Inputs.** `R` = the set of ingest-accepted registry records (each already type-clamped and
HLC-absolute-window-accepted per §3.5; quarantined records are NOT in `R`). Each record carries
its immutable tuple `t`, its locally-claimed `id`, and its raw emitter `hlc`, with `mintedBy`/
`hlc.node` pinned to the authenticated envelope origin.

**Pure functions used (no live occupancy, no wall-clock, no arrival order):**
- `cand(t) = -(abs(hash(routingKey(t))) + 1)` — the frozen candidate, a pure function of the
  tuple's routing key.
- `≺` — a **content-deterministic strict total order** over tuples: compare `(hlc.physical,
  hlc.logical, hlc.node)` of the tuple's minting record, and break any remaining tie on the
  **IMMUTABLE tuple byte-form `(platform, channelId, threadTs)`** compared lexicographically —
  NOT the canonical-key string, which is MUTABLE (the `_`→teamId upgrade rewrites it, so a
  key-string tiebreak could order the same pair differently before vs after an upgrade —
  R2-adversarial-4, a latent landmine even though the branch is dead code today). `≺` is total
  even if two records carried identical HLCs, because the tuple is unique per record.
- `sticky(t)` — TRUE iff the record set `R` carries a **durable-binding marker** for tuple
  `t`'s assigned id (R2-adversarial-1, below): when a durable consumer BINDS to an id
  (a commitment opens, a working-set carry attaches — the §3.3 `durableBinding` mint paths),
  the registry journals AND replicates a `sticky` flag on that id's record (one more
  replicated field, type-clamped boolean, emitted through the same §3.5 channel; commitments
  themselves also replicate via CommitmentsSync, but the merge consults ONLY the in-`R`
  sticky marker so the input stays deterministic and machine-identical). `sticky` is
  monotonic (never un-set by replication; it expires only with the binding lifecycle, a
  local-authoritative metadata change like `reachability`).

**Assignment (the pure resolution of `R` to one id per tuple):**
1. **Canonical reservation (A3) — with the sticky-canonical override (R2-adversarial-1 /
   security-NEW-1: a durably-bound id is NEVER demoted).** Each id `cand(t)` is RESERVED for
   tuple `t` and for `t` alone. Where several distinct tuples share the same `cand` (a genuine
   collision), ownership of that canonical id resolves in this order:
   (i) a tuple whose CURRENT assignment of that id is `sticky` (a durable binding is live on
   it) keeps it — a colliding newcomer, EVEN with a lower HLC, is forced to the step-2
   displacement walk instead. Rationale: consumers hold `number`-typed topicId VERBATIM (168
   files) and CANNOT rebind to tuples, so demoting an id a live commitment is bound to would
   strand or mis-deliver that binding — the A5 alias-repoint (which assumes the demoted id
   becomes FREE) and the A3 canonical-reservation (which re-claims it for the promoted tuple)
   are mutually inconsistent exactly in this case; sticky-canonical removes the case.
   (ii) among non-sticky claimants (or in the never-observed case of TWO sticky claimants —
   possible only if both machines opened durable binds on the same collision pair during a
   partition), the `≺`-least owns it; the rest are *displaced*. When a DISPLACED tuple had a
   LOCAL durable binding (the sticky-vs-sticky loser, or a binding opened on a provisional
   local id the merge displaced), the registry performs a **heal-forward repoint** of that
   binding's id to the tuple's post-merge assigned id (journaled, idempotent) + ONE deduped
   attention item naming the episode — never a silent strand.
2. **Displaced-tuple resolution (A1/A4 — key-derived, never occupancy-order).** A displaced
   tuple walks the FROZEN down-sequence `cand(t), cand(t)-1, cand(t)-2, …` and takes the first
   offset that is (a) not a reserved canonical of ANOTHER tuple in `R`, and (b) not already
   taken by a `≺`-earlier displaced tuple. This is a pure function of the tuple set — no live
   occupancy, no arrival order — so both machines assign the same offset. **The §3.3 local
   mint applies this SAME rule — one shared implementation, §10-pinned (R2-adversarial-2).**
   A walk exceeding `MAX_PROBE_DISTANCE` is the §3.6 pending-mint degradation, identical on
   both machines.
3. **Winner id per tuple** = the id from step 1 or 2. Any OTHER id present in `R` for that same
   tuple (a machine's provisional local mint that disagreed — §3.3) becomes a **one-hop alias →
   winner id** (the atomic winner-flip, §3.5 — which, per step 1(i), never demotes a sticky
   id). No id resolves to more than one tuple; no tuple resolves to more than one winner.

**Field merge (per surviving entry).** Identity fields (`id` after assignment, `tuple`) are
**monotonic/immutable**. Non-identity metadata (`label`, `reachability` [local-authoritative
only], `workspaceId` [local-authenticated concrete only], `hlc`) is **mutable, last-writer-wins
by the raw-HLC compare** with the `≺` tiebreak — again a pure function of `R`.

**Algebraic properties (the CRDT-style guarantees §10 fuzz-tests):**
- **Commutativity + associativity** — `merge(a, b) = merge(b, a)`; `merge` over `R` is
  order-independent (ingest order, machine order, replication interleaving all irrelevant).
- **Idempotence** — re-ingesting a record already in `R` is a no-op (§3.4 replay is idempotent).
- **Convergence** — two machines holding the same `R` produce byte-identical `resolve(id)` for
  every id. §10 pins a fuzz test permuting arrival order across **≥3 machines** and asserting
  byte-identical `resolve()` for every id.
- **Totality honesty (R2-adversarial-5):** convergence-TOTALITY is bounded by
  `MAX_PROBE_DISTANCE` — a ≥64-deep GENUINE collision chain resolves to the §3.6 pending-mint
  degradation, and two machines holding UNEQUAL record sets `R` in that regime are
  non-convergent until their sets equalize. Astronomically unlikely (64 consecutive
  occupied offsets near a random point in a 2³¹ space), but stated rather than implied.

**"Same `R` on every machine" is DELIVERED by the transport, not assumed
(R2-adversarial-3).** The bespoke store rides the journal transport whose generic `receive()`
skew check is RECEIVER-relative (pool-relative reference clock) — an online machine and an
offline-then-returning machine could quarantine DIFFERENTLY, silently breaking the equal-`R`
premise (permanently, if the ingest cursor skips a quarantined record). Therefore the
conversations store's ingest is **EXEMPT from the foundation's pool-relative skew
quarantine**: its OWN machine-independent anti-forgery gate is the §3.5 FIXED ABSOLUTE HLC
sanity window (identical constants on every machine), which is the acceptance check that
matters for convergence. Defense-in-depth: if any transport-level quarantine nonetheless
holds a conversations record, that record is **RETRIED on a later pass, never cursor-skipped**
(the cursor does not advance past it as consumed). §10 pins the test: a returning machine
with a stale pool reference ingests the same record set and reaches byte-identical
`resolve()`.

The seize-refusal (§3.5) is the ONLY non-merge outcome: it fires exactly when a record's claimed
`id` is unreachable under steps 1–2 for its own tuple (neither its `cand` nor a within-bound
collision-probe offset) — i.e. a genuine hijack/corruption — and such a record is quarantined out
of `R` entirely, so it can never perturb the pure resolution above.

### 3.6 Failure modes (decided)

| Failure | Behavior |
|---|---|
| Registry unavailable/corrupt at inbound time | **Fail toward delivery**: compute `candidate(routingKey)` in-memory — byte-identical to today's legacy behavior — proceed, and journal a pending-mint (keyed/deduped by canonical key: ONE pending-mint per conversation, not per message; bounded with a loud drop counter). **Collision-blindness guard (B6):** whenever the in-memory reverse index is still readable (breaker-drop, slow/contended registry), consult it BEFORE using the raw candidate — a candidate occupied by a DIFFERENT tuple resolves via the §3.5.1 probe for the READ, never a cross-conversation misdeliver; only a fully-lost index (nothing to consult) falls back to the bare candidate as the last-resort floor. Corrupt file → quarantine-aside + rebuild (§6.2). |
| Registry present but SLOW/contended | The id is assigned SYNCHRONOUSLY in-memory (probe included) so returned==persisted; only the durable write is deferred; mutate-queue overflow degrades to the pending-mint path (never a blocked inbound). |
| Registry UNAVAILABLE, a binding was made against the raw candidate, then registry recovers and the candidate is occupied by a different tuple | Heal FORWARD: the affected binding's id is repaired to the newly-assigned (probed) id — NOT aliased onto the live foreign id (§3.5 refuses same-id/different-tuple; the raw candidate is only ever exposed on the registry-unavailable path, and only that path's bindings need forward repair). The heal is journaled + one deduped attention item. |
| Two machines mint the same tuple concurrently | Same candidate → same id → replication merges silently. Probe divergence → §3.5 alias rule, deterministic on both sides. |
| A peer replicates garbage | Type-clamp + id↔key coherence + tuple-first matching + seize-refusal + alias-not-ingested (§3.5). Fails closed on the registry write, never on message delivery. |
| Mint requested for an unparseable/foreign key | Refused (typed error). Callers treat it as "no durable id" and keep legacy behavior for that message. |
| Registry lost AND journal lost AND no backup | Deterministic re-mint from the channel registry (§6.2), with the documented probe-order risk. This residual is the ONE true "aliases may be needed / re-verify" window; it raises an attention item. |
| Operator sets `recording.enabled:false` (or `disableJournalFsync:true`) at runtime (D1) | DELIBERATE degradation to the same in-memory-candidate path as the top row, applied WITHOUT a redeploy: candidate computed + collision-checked read (B6), delivery proceeds, NO durable write / NO journal fsync. Behavior-identical to legacy hashing; the freeze-precedent kill-switch. **A durable-state open on a MINTED id while recording is off is REFUSED (typed `conversation-recording-disabled` + one deduped attention item) — an unjournaled bind would be unresolvable after restart (R2-integration-§9); positive Telegram binds unaffected.** Re-enabling resumes durable recording; already-live ids keep resolving from the in-memory cache. |

### 3.7 Rejected alternative: SQLite (an honest justification — gemini-C3)

This spec hand-rolls a mini-database: an append-only WAL (§3.4), fsync rules, a snapshot
high-water mark, rotation, idempotent replay, and torn-tail handling. SQLite in WAL mode solves
atomicity, crash-recovery, secondary indexing, uniqueness constraints, and bounded writes with far
less bespoke correctness burden — and there IS SQLite precedent in this codebase
(`pending-relay-store.ts`, `TopicMemory`). "JSON house style" alone would NOT justify a
durability-critical store, so the real reason is stated plainly:

**The load-bearing reason is REPLICATION, not house style.** The multi-machine replication
foundation this store must ride (§3.5, `multi-machine-replicated-store-foundation.md`) is
**JSON-file-based end to end**: per-origin record namespaces, the snapshot-then-tail transport,
the union reader, the quarantine ring, and rollback-un-merge all operate over JSON files on disk.
A SQLite-backed conversations store could not be a `ReplicatedStoreReader`-adjacent bespoke store
riding that vehicle without a second, parallel replication path — precisely the shared-code
divergence §3.5 works to avoid. The store is JSON+WAL so it can be a **zero-foundation-change**
consumer of the existing JSON replication substrate (the `TopicPinReplicatedStore` precedent).
The WAL is deliberately kept MINIMAL (append line, discard torn tail, replay `seq >` high-water) —
not a general database — because its ONLY job is to close the assign→snapshot crash window for
probed/thread-level ids. **Verification residual, stated honestly (R2-lessons-5):** WAL
crash-consistency is only partially verifiable by SIGKILL-style tests — a kill lands at a
process boundary, while the real hazards (power loss mid-fsync, filesystem reordering) are
below it; the §10 torn-tail/replay tests cover the reachable failure shapes and the rest is a
NAMED residual risk. This residual is an additional reason the §11.10 SQLite migration (whose
WAL is battle-tested at exactly these layers) should land SOONER on the evidence tripwire,
not merely at the size ceiling.

**SQLite is the named migration target, NOT a permanent rejection.** At the §3.4 scale ceiling
(~50k entries / ~10MB) the JSON snapshot's O(N) write is the real constraint, and the honest move
is to SQLite (or append-journal-as-primary). That migration is tracked as **§11.10** — so SQLite
is reconsidered exactly when its advantages (indexing, bounded writes, no full-store serialize)
start to outweigh the replication-substrate coupling that makes JSON the right Phase-1 choice, and
the choice is re-made on evidence (the §GET /conversations/health entry-count tripwire), never by
inertia.

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
restart hazard (§1) as a side effect. **Read-shaped callsites use a read-only path
(integration-nit):** a pure comparison like `server.ts:9883` (`slackChannelToSyntheticId(channelId)
=== topicId`) must route through the read-only `registry.resolve` / id→key reverse index,
NOT `mintForRoutingKey` — otherwise a comparison acquires a get-or-create WRITE side-effect.
The §4 map above is explicit about which callsites mint (dispatch, heartbeat) vs merely
resolve (comparisons, suppression matching).

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
    deterministicKind?: 'reachability-floor' | 'resource-denial' // NOT an open boolean (B2)
}):
  id > 0  → today's Telegram path (POST /telegram/reply/:id) — queue, dedup, idempotency,
            tone gate: all existing layers, and proxy sends keep their existing
            isProxy tone-gate-bypass EXACTLY as today (no new gating introduced).
  id < 0, deterministicKind set → GATE-EXEMPT deterministic Slack send (direct
            ctx.slack.sendToChannel with thread_ts). **The gate exemption is STRUCTURALLY
            constrained (B2):** `deterministicKind` is a FIXED ENUM (`reachability-floor` |
            `resource-denial`), NOT an open `deterministic:true` boolean; the notice TEXT is
            TEMPLATED SERVER-SIDE per kind — templates COMPILE-TIME enumerated (one fixed
            template id per kind, no runtime template registration) with SCHEMA-VALIDATED
            substitution fields (each field shape/length-clamped: a session name, a count, a
            topic id — never free text), so a caller cannot smuggle the CLI/path/secret leak
            the tone gate exists to block through a substitution value (codex-R2-5) — AND the
            arm is restricted to an ALLOWLISTED internal caller set (the two blessed sites:
            cold-start reachability fallback §6.1-3, resource-denial notice). §10 pins a lint/
            test asserting ONLY those two call sites pass a `deterministicKind` — a third is a CI
            failure — plus a substitution-injection test (a freeform/path/secret-shaped
            substitution value is REJECTED by its field schema, never rendered). This mirrors the Telegram G1 design so the "always reachable" floor on Slack
            is never held by the tone gate failing closed under the very pressure it reports
            (lessons-F3 / The Agent Is Always Reachable corollary 2).
  id < 0 (normal) → registry.resolve(id) on the OWNING machine (§5.0 ownership predicate) →
            **ambiguous-outcome idempotency guard (E1)** → POST /slack/reply/:channelId
            with thread_ts (the route runs the tone gate — routes.ts:12163-12186; thread-
            level conversations deliver IN-THREAD). Proxy sends carry isProxy so the Slack
            arm honors the same bypass as the Telegram arm (beacon parity).
  id < 0 on a NON-owning machine, or unresolvable, or no local Slack adapter → TYPED FAILURE
            (never a silent drop, never a success-shaped return; §5.1). ONE deduped
            attention item names the heal paths.
```

**§5.0 The ownership predicate — ONE definition (integration-I1).** "Owning machine / serving
machine / lease holder / local adapter / local-origin entry" are used adjacently in this spec but
mean ONE thing, defined here and used by `deliverToConversation` verbatim:

> **`ownsConversation(id)` ≡ this machine has a LOCAL Slack adapter AND a LOCAL-ORIGIN registry
> entry (`adopted-legacy-hash` | `minted-probed` | `adopted-replicated`) resolving `id`.**

In the Phase-1 single-Slack-machine reality this is exactly "the awake machine that holds the
Slack socket." The lease-holder is a DISTINCT predicate; in the active-active future the two can
differ (§5.1 lease-holder note), and reconciling them is the tracked §11.2 follow-up. Every place
this spec says "owning machine" resolves to `ownsConversation(id)`.

**§5.0(a) Ambiguous-outcome idempotency guard (E1) — ships WITH the funnel.** Telegram is
protected by the ~15-min exact-duplicate suppression window; Slack is NOT until Phase 2.2. Yet
PromiseBeacon re-arms + re-fires on every `not-delivered` result, so an **ambiguous** send (Slack
actually posted, but the ack was lost → the funnel returns a transient `not-delivered`) would make
the beacon DOUBLE-POST the heartbeat into the user's thread. To close that WITHOUT waiting for the
Phase-2.2 robustness lane, the `id<0` funnel arm carries a **minimal per-`(conversationId,
logical-send-identity)` short-window dedup** applied AT the funnel: a repeat send of the same
logical send to the same conversation inside the window is suppressed (returns a distinct
`already-delivered-recently` typed result the beacon treats as delivered, so it does NOT
re-escalate). Four load-bearing refinements (R2-lessons-1 a/b, R2-security-NEW-3,
R2-security-NEW-4):
- **The window is an INVARIANT, not a copied constant (R2-lessons-1a).**
  `ambiguousDedupWindowMs = 900000` was copied from Telegram, but PromiseBeacon re-fires at a
  ~20-minute base cadence — an ambiguous re-post at the REAL cadence would land OUTSIDE a
  15-minute window and double-post anyway. The pinned invariant is
  **`ambiguousDedupWindowMs ≥ (max beacon re-fire interval) + margin`** — stated in config
  docs, asserted at startup (a violating configuration logs + clamps UP to the floor), and
  tested at the REAL beacon cadence (§10: the idempotency test re-fires at the beacon's
  actual re-fire interval, never a sub-window fast retry). Default:
  `ambiguousDedupWindowMs = 1_800_000` (30 min ≥ the 20-min beacon base + margin).
- **The guard keys on a STABLE logical send identity, not the raw content-hash
  (R2-lessons-1b).** A beacon heartbeat interpolates elapsed/liveness text ("…23m elapsed"),
  so a retry's bytes differ and a content-hash never matches. The dedup key is
  `(conversationId, logicalSendId)` where `logicalSendId` = **`commitmentId + beacon send
  sequence number`** for beacon sends (the beacon passes it via `opts`), falling back to the
  content-hash ONLY for callers that have no logical identity. §10 pins: a beacon retry whose
  interpolated text differs IS suppressed (same logical send), while the NEXT scheduled
  heartbeat (new send seq) is NOT.
- **The window entry is recorded ONLY on a likely-posted outcome (R2-security-NEW-3).** The
  entry is populated on success OR on an ambiguous/ack-lost outcome — NEVER on a clean
  transient failure where the funnel has positive evidence the message did not post (Slack
  5xx / connection refused before the request was accepted). Recording on ATTEMPT would make
  a clean-transient retry falsely suppressed → SILENT loss of the heartbeat. §10 pins the
  distinction: clean transient failure → retry NOT suppressed; ambiguous → single post.
- **The dedup map is BOUNDED (R2-security-NEW-4 / scalability-2):** it reuses the §5.2
  `AttentionTopicGuard` bounded/evicting structure (hard cap + `evictStaleSources`) — never a
  monotonic map; the §10 burst test asserts the bound.
It is length-gated exactly like the Telegram dedup (brief acks never suppressed) and
bypassable with `allowDuplicate` for the rare genuine resend. §10 pins the idempotency test
(ambiguous-outcome resend at the real cadence → single post).

**Owning-machine vs lease-holder gate (integration-F2).** In today's single-Slack-machine /
one-awake-machine reality the Slack socket lives on the awake machine, which IS the lease
holder, so the funnel's `ownsConversation(id)` gate (§5.0) and PromiseBeacon's existing
lease-holder-gated sweep (`PromiseBeacon.ts:522-523`) COINCIDE — this is a no-op today. In a
FUTURE active-active multi-machine-Slack world (§9's `stateSync.conversations` posture) the
single lease-holder is not necessarily the machine holding a given conversation's socket, so
a lease-holder beacon could deliver to a minted id it does not own → a by-design non-owning
typed-failure that must NOT arm §5.1's N-fail dead-letter. Reconciling lease-holder with
conversation-owner for active-active Slack is an explicit tracked Phase-2.x follow-up
(§11.2); until then, §5.1's dead-letter counter is scoped to REAL delivery failures on the
owning machine, never a by-design non-owning-machine refusal. **This scoping is pinned NOW by a
test (§10): a non-owning-machine typed-failure NEVER increments the dead-letter counter; only an
owning-machine real delivery failure does.**

**The multi-machine cliff is LOUD, not a silent stream (integration-I1).** There is one
dangerous intermediate posture: `>1` machine present AND `CommitmentsSync` live (so a minted-id
commitment can replicate to a machine that never minted it) BUT `stateSync.conversations` still
DARK (so `resolve(id)` fails there). Left implicit, that surfaces as an unbounded stream of
undeliverable-beacon attention items. Instead, ONE deduped BOOT attention item fires when exactly
that combination is detected — *"multi-machine Slack follow-through needs
`stateSync.conversations` enabled"* — so the cliff is named once, loudly, and the operator's fix
(enable the replicated store, §6.1 step 9) is obvious. Single-machine agents never reach it.

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
- **Permanent-vs-transient classification (adversarial-A2/NEW#1, codex-X4, lessons-NEW-3).**
  The Slack arm reads the raw error code from **`SlackApiError.slackError`** (`SlackApiClient.ts:131,138`
  — the `data.error` STRING returned by `chat.postMessage`, NOT the channel-property boolean
  `channel.is_archived`) and classifies `{is_archived, channel_not_found, not_in_channel}` as
  a PERMANENT `conversation-unreachable`. **The code is `is_archived`, NOT `channel_archived`.**
  This set is DISTINCT from the adapter's token-scoped `SlackApiError.permanent`
  (`PERMANENT_ERRORS`, `SlackApiClient.ts:32-41` = auth/token codes) — it must not reuse that
  flag. **Drift canary (L5):** an unrecognized permanent-SHAPED Slack error (a channel-state
  code not in the set — Slack could add one) does NOT get silently mis-bucketed; it is treated
  transient (safe default — beacon retries) AND raises ONE deduped attention item so the set
  can be updated. §10 pins the exact set + the canary in a Tier-1 test. On a permanent error
  the entry's `reachability` flips to `unreachable` (LOCAL-authoritative ADVISORY metadata,
  never deletion, NEVER gates delivery — the OWNER reads only its OWN locally-observed
  reachability, never a peer's replicated value, §3.5). The beacon treats it as TERMINAL → a
  `raiseAttention` dead-letter — **aggregated at the EMITTER on a mass event (R2-lessons-2 /
  P17):** terminal dead-letters within one coalescing window collapse into ONE summary
  attention item ("N conversations became unreachable — bot removed from <workspace>?", with
  the conversation list in the body), never one item per beacon — a bot-removed-from-workspace
  event yields ONE item, not N. §10 adds the burst-invariant test for the mass-unreachable
  path (N simultaneous permanent errors → one aggregated attention item). The flip is
  IDEMPOTENT (already-`unreachable` → no write) and
  rides the SAME batched flush, so a mass event (bot removed from a workspace, org offboarding)
  coalesces into one write, not an O(N)-per-channel write storm on the failure path
  (scalability-F2). Transient errors retry and never durably flip. `reachability` auto-clears
  to `ok` on the next successful delivery or authenticated inbound (a re-invited / un-archived
  channel is never stuck; permanent-as-transient self-heals via the N-fail dead-letter,
  transient-as-permanent self-heals via auto-clear — the bounded blast radius L5 requires).

**§5.2 Bounded notification surface (P17 — lessons-F8).** The funnel is the ONE chokepoint
every migrated consumer rides, so the per-conversation delivery budget lives HERE: `id < 0`
deliveries carry a per-conversation rate budget + aggregation rule. Its state REUSES the
`AttentionTopicGuard` structure directly (scalability-F3) — a windowed `Map` with a
`maxTrackedSources`-equivalent hard cap AND `evictStaleSources` — so the budget state is
bounded by ACTIVE conversations per window, NOT a monotonic map keyed by every conversation
ever delivered to (which would grow to 100k+ at the §3.4 ceiling). A flood of attention
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
| 16 | Message stores / TopicMemory | `topic_id INTEGER` (`TopicMemory.ts:249,288`); dual-write hashes bare channelId (`server.ts:13216-13227`) | NO schema change. **DECIDED (adversarial-A7):** the dual-write keys on the RESOLVED conversation id going forward (§3.2); pre-existing thread rows written under the channel id stay channel-attached (named + accepted, mirroring the §3.2 mode-flip consequence style). Under today's thread-routing-DISABLED default a thread reply resolves to the CHANNEL id, so new + old rows share it — no split, no memory-gap. **Forward-note:** the split materializes only when Phase 7.2 flips the thread-routing default; Phase 7.2 inherits it (and the §3.2 deduped mode-flip operator notice), a tracked non-goal here (§11.5). |
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
   beacon heartbeat land back in that thread (delivery via `/slack/reply`'s current
   guarantee — tone gate + the §5.1 classification; retry/dedup/idempotency is Phase 2.1
   and rides UNDER the funnel without changing this proof).
3. **Cold-start fallback**: Slack spawn failure answers in-channel through the funnel's
   DETERMINISTIC gate-exempt arm (kills the `console.error` hole; extends "The Agent Is
   Always Reachable" to Slack without riding the fail-closed tone gate). **Scope honesty
   (R2-lessons-3): this floor holds only while the Slack TRANSPORT is up — the deterministic
   arm still sends through the local Slack adapter, so a down/disconnected adapter (socket
   loss, token revocation, Slack outage) is the gap the §11.2 SlackLifeline exists to close.
   The claim is "no silent spawn-failure while Slack is reachable," not "always reachable on
   Slack" unqualified.**
4. **AutonomousProgressHeartbeat** funnel swap.
5. **Attention items**: accept + deliver on minted ids via the funnel's P17-budgeted
   `id<0` path (per-conversation Slack ack UX stays Phase 2.3).
6. **Reap notices / PendingRelay drain** funnel swap (schema untouched).
7. **Working-set / profile-carry seam** (§6.0 #12): `idForSessionKey` get-or-create at
   `onAccepted` — Slack conversations join Goal-2 transfer machinery.
8. **Route-surface cleanups**: the 26 `Number()` coercions audited (**acceptance criterion:
   each coercion either accepts negatives verbatim — test-pinned for the routes commitments/
   attention/profiles touch — or is documented Telegram-scoped like `routes.ts:24915`**).
9. **Bespoke conversations replicated store** (dark, dev-gated, dryRun-first — the
   multi-machine increment integration-F1/security-NEW-2/lessons-F1 required as a named,
   scheduled step, not a hand-wave): the id-keyed replicated store doing its own tuple-first
   merge + local alias derivation (§3.5), re-applying the WS2 hardening. **Full new-replicated-
   KIND wiring checklist (integration-R3-i — "zero foundation change" ≠ "zero replication-
   subsystem wiring"), each mirroring the TopicPin precedent:** (a) JournalKind registration —
   BOTH the static half (`CoherenceJournal.JOURNAL_KINDS`) and the dynamic half
   (`ReplicatedKindRegistry`), cf. `TOPIC_PIN_RECORD_KIND` + `TOPIC_PIN_KIND_REGISTRATION`;
   (b) a `StateSyncStores` config-surface entry for `conversations` so
   `isStoreEmissionEnabled('conversations')` + the `selfStateSyncReceive` funnel resolve
   (the four funnels at `devGatedFeatures.ts:404-407`); (c) the `stateSyncConversations`
   `DEV_GATED_FEATURES` entry (the one-line pattern at `devGatedFeatures.ts:408-449`); (d) the
   `RollbackUnmerge` `getByStore` store-key wiring (the `TOPIC_PIN_STORE_KEY` precedent — the
   §9 "rollback-unmerge drops a peer namespace on disable" claim structurally depends on it);
   (e) the emitter dark-gate. Plus a wiring-integrity regression test asserting the 7 existing
   WS2 stores still surface conflicts unchanged. This increment is what §9's "enabling
   `stateSync.conversations` is the supported multi-machine Slack posture" depends on;
   single-Slack-machine deployments (today) never reach it.

**Dark-window honesty (adversarial-A6/NEW#4).** While `followThrough` is dark/dry, a session
CAN mint an id and open a commitment on it. To avoid a silently-broken promise, the
commitment path accepts it and immediately raises ONE deduped attention item marking it
undeliverable (chosen over a typed `undeliverable-while-dark` refusal because it preserves
the commitment record for the live proof; the fleet never reaches this state until
`followThrough` graduates). **That undeliverable notice MUST route through the existing
`slack-attention-channel` mirror (§6.0 #3) or the Telegram lifeline on a dev agent — NOT the
dark minted-id funnel** — otherwise the "never silence" notice is itself swallowed by the
same dark gate it reports (adversarial-NEW#4). Silence is not an option.

### 6.2 Adoption pass + rebuild (boot-time ensure; PostUpdateMigrator backup-manifest entry)

**Supervision Tier 0 — the standard-aware exception rationale (P7 / LLM-Supervised Execution —
lessons-F11 + lessons-NEW-1; conformance-gate H1).** The standard requires ≥Tier-1 LLM
supervision on every critical pipeline; the registry/journal-replay rebuild path and the
increment-9 bespoke-store MERGE claim Tier 0. This is a DELIBERATE, standard-aware EXCEPTION, not
an oversight: an LLM supervisor adds value only where a JUDGMENT call exists to wrap — and these
pipelines have none. The rebuild is a **deterministic golden-parity re-derivation** — the same
records replay to a byte-identical registry, and §3.5.1 proves the merge is a pure function of the
record set. The adoption pass, the funnel classification, and the merge (type-clamp, id↔key
coherence, seize-refusal, quarantine, alias derivation, raw-HLC winner selection) are all pure
deterministic transforms over untrusted peer data with NO context-dependent policy decision. The
**supervisor-equivalent is the golden-parity + deterministic-convergence + fuzz test suite (§10)**:
it verifies the exact property an LLM validator would be asked to eyeball (did the rebuild/merge
produce the one correct output?) — but mechanically, exhaustively, and without an LLM's own error
rate. Wrapping a byte-deterministic function in Haiku would ADD a non-deterministic failure mode
to a pipeline whose entire value is determinism. So Tier 0 is the CORRECT tier here, declared
explicitly per P7 (each is a first-class automated pipeline), with the test suite as its named
supervisor-equivalent — NOT an implied or skipped supervision decision.

Idempotent, boot-time ensure (inside a batched-save window, §3.4): for every channel in
`slack-channel-registry.json`, `mint(slack:<team>:<channel>)`. This pre-registers all
known channel-level conversations with their legacy-hash ids before any consumer asks.

**The adoption pass rides the SAME growth ceiling as inbound mints (security-B8).** It runs
inside the batched-save window AND under the §3.3 mint-rate breaker (the batched cap), so a
bloated `slack-channel-registry.json` cannot flood the store on boot. Because Slack auto-join
makes registry growth reachable by an unauthorized workspace member (a channel appears in the
registry without any authorized-sender activity), adoption is **gated to channels with ≥1
authorized-sender message on record** — a channel that only exists because the bot was auto-added
is NOT pre-minted (it mints lazily on its first authorized inbound, the same gate all mints ride).
The auto-join→registry-growth coupling is called out in the §3.4 growth-honesty section: adoption
is a pre-population convenience, not an unbounded-growth vector.

**Rebuild after registry loss (scalability-S2, adversarial-A5, security-m3, lessons-F10):**
recovery order is (1) restore BOTH `state/conversation-registry.json` AND the retained
`logs/conversation-registry.jsonl` set from BACKUP (both are in the manifest, §3.4 C1), then
replay any journal tail with `seq > snapshotHighWaterSeq` (primary path — snapshot + tail
compose to the exact pre-crash state); (2) if there is NO backup but the local journal survived,
REPLAY `logs/conversation-registry.jsonl` (§8 — append-only, records every mint/probe/alias with
key+id+seq order, so thread-level entries AND probe order are restored exactly); (3) only if the
JSON snapshot, its backup, AND the journal are ALL gone (a total disk-loss with no backup): the
channel-level ids **self-heal on next inbound because the channel candidate is deterministic** —
a channel's `slack:<team>:<channel>` re-mints to the same id the moment it next receives an
inbound. The boot adoption pass (from `slack-channel-registry.json`, if it too survived) is a
pre-population CONVENIENCE that warms these ids before the first inbound; it is **NOT a
disaster-recovery requirement** and `slack-channel-registry.json` is therefore NOT a backup-
manifest entry. **Only PROBED and THREAD-LEVEL ids are genuinely unrecoverable in case (3)** (a
probe order is lost, a thread-level id has no re-mint trigger until its thread next receives a
reply) — which is exactly the residual the WAL closes in cases (1)/(2), and this case raises an
attention item flagging the documented probe-order risk. The audit log's retention (§8) MUST
exceed the backup cadence so journal replay is always available between backups.

PostUpdateMigrator additions: (a) BOTH `state/conversation-registry.json` AND the
stateDir-relative journal GLOB `logs/conversation-registry.jsonl*` into
`config.backup.includeFiles` (idempotent set-union, stateDir-relative — §3.4 journal-path pin;
the Tier-2 test asserts BOTH are present AND resolve to real files — C1/R2-integration-1; NO
pre-backup flush hook — dropped per R2-integration-2); (b) the CLAUDE.md Capabilities entry for
`GET /conversations*` via `migrateClaudeMd()` (content-sniffed, idempotent — reaches EXISTING
agents, not just new inits; integration-I5); (c) the `conversationIdentity.recording.enabled`
default (existence-checked, only ADDING `true` if absent, NEVER materializing `false` — §9 D1);
(d) nothing else — no store rewrites anywhere.

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
- **Bind-time authority — minting is gated, BINDING must be too (security-B7).** The registry
  gates who can MINT (authorized-sender inbound, server-side chokepoints), but a durable-state
  BIND (`POST /commitments`, working-set carry) on an arbitrary `topicId` was ungated — a buggy
  or confused session could `POST /commitments` with `topicId = <another conversation's minted
  id>` and have its beacon deliver into that OTHER conversation's thread. So a **bind-time
  check** is enforced at every durable-state open: a session may open durable state ONLY on a
  conversationId present in its OWN authenticated bootstrap context (the `conversationId` carried
  into the session at §6.3) OR a Telegram-native POSITIVE id it is bound to — where **"bound to"
  is DEFINED symmetrically with the negative-id rule (R2-security-NEW-5): the positive topicId is
  present in the session's authenticated bootstrap context (the topic the session was spawned
  for / the `[telegram:N]` binding injected at spawn), never merely a number the session chose to
  claim.** §10 pins both directions of the positive-id branch (own bootstrap topic → allowed;
  arbitrary foreign positive id → refused). The consumer records
  `boundBy`/`origin` on the commitment (the authenticated session identity). A bind whose target
  id is neither the session's own bootstrap conversation nor a positive id it owns is REFUSED with
  a typed `conversation-bind-not-authorized` error + ONE deduped attention item — never silently
  delivered into the foreign conversation. §10 pins the cross-conversation-bind refusal test.
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
- `<stateDir>/logs/conversation-registry.jsonl` (the §3.4 journal-path PIN — the stateDir
  root, `.instar/logs/…`, NOT the agent-home `logs/` root) — append-only audit of every
  mint/adopt/alias/probe/
  refusal (ids + keys only, never content). **Rotation:** size/line-capped with retention
  EXCEEDING the backup cadence (so §6.2 journal replay is always available between
  backups) — the one rotation whose floor is a recovery requirement, not just hygiene.

## 9. Config, rollout, migration parity

```jsonc
"conversationIdentity": {
  // Foundation (registry + consolidation + resolve routes + eager mint): ALWAYS ON once
  // shipped — behavior-identical recording of ids already in use (the reap-log posture).
  "recording": {
    // D1 — the runtime KILL-SWITCH the freeze precedent demands (CommitmentTracker 2026-06-21:
    //   an always-on eager-mint + journal-fsync store whose ONLY degradation trigger was file
    //   corruption is exactly the shape that froze production). This lever forces the §3.6
    //   in-memory-candidate degradation (compute candidate(routingKey), deliver, NO durable
    //   write / NO journal fsync) WITHOUT a redeploy — behavior-IDENTICAL to today's legacy
    //   hash when on. Correctness claim NARROWED (R2-integration-§9): for CHANNEL-LEVEL ids
    //   and all delivery the flip loses only durability — but a durable BIND opened on a
    //   MINTED id while recording is off would be unresolvable after a restart (a probed/
    //   thread-level id with no journal line), which IS a correctness loss for that
    //   commitment. Therefore, while `recording.enabled:false`, a durable-state open on a
    //   MINTED id is REFUSED with a typed `conversation-recording-disabled` error (+ ONE
    //   deduped attention item); Telegram positive-id binds are unaffected. Pinned by a §10
    //   test. The kill-switch is an emergency lever — refusing new Slack binds during the
    //   emergency is the honest trade against silently minting promises that die on restart.
    "enabled": true,        // default true; existence-checked in migrateConfig; NEVER
                            //   materialized as a literal `false` (a default-shaped false would
                            //   force-dark the store — the #1001 mechanism). Pinned by a unit test.
    "disableJournalFsync": false // narrower escape hatch: keep in-memory recording but skip the
                            //   fsync on the durable/probed path (relieves fsync pressure without
                            //   losing the in-memory id — the §3.6 read stays collision-safe).
  },
  // The lever below reverts DELIVERY, not bookkeeping.
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
  for `GET /conversations*` reaches EXISTING agents via `migrateClaudeMd()` (§6.2) AND NEW
  agents via the `src/scaffold/templates.ts` → `generateClaudeMd()` template entry (P5
  Agent Awareness needs the template; P3 Migration Parity needs the migrator — both, or new
  `init` agents never surface it — lessons-F3); no hook/skill changes.
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
  post-merge; **the local probe loop is bounded by `MAX_PROBE_DISTANCE=64` (the SAME constant
  the ingest coherence check uses) — a >64 probe degrades to the pending-mint path, never a
  peer-un-ingestable id** (local-probe-distance ≤ ingest-bound invariant).
- **Local collision-class displacement (R2-adversarial-2):** TWO tuples colliding at ONE
  candidate, minted locally in EITHER order, receive DISTINCT ids (no reverse-index
  overwrite), and the local assignment is byte-identical to what the §3.5.1 merge computes
  for the same tuple set — the **shared-implementation equivalence test** (the same
  displacement function serves §3.3 and §3.5.1 step 2; feeding it the same tuple set through
  both entry points yields identical assignments). Also asserts `candidateCollides` performs
  NO linear scan (bounded ops per mint against a large seeded store — R2-scalability-1).
- **WAL crash-durability** (the four-reviewer round-3 finding): a PROBED mint and a
  durable-binding-forced mint append+fsync their journal line BEFORE returning the id; kill
  the process AFTER the binding commits but BEFORE the batched snapshot flush → on reboot the
  id STILL resolves (journal replay); a pure speculative non-probed mint rides the snapshot
  only (no synchronous journal write); the durable-binding path is never dropped by the
  pending-mint drop. Assert no whole-file write on the commitment-open path.
- Ingest clamps: positive/foreign-platform id refused; malformed key/shape refused; rebind
  refused; **id further than `MAX_PROBE_DISTANCE` from candidate(key) refused + quarantined**;
  **a legitimately-probed entry WITHIN the bound is ACCEPTED even without locally-visible
  occupancy (out-of-order replication — no false quarantine)**; seize (same-id-different-tuple)
  refused; **placeholder-skew (same-tuple, `_` vs real teamId) MERGES both orderings, no
  false forgery**; **replicated alias payload refused**; **a peer-supplied `origin` field is
  OVERWRITTEN to `replicated` on ingest (never trusted from the wire; delivery-authority
  discriminator is locally assigned)**; HLC physical clamp; alias one-hop-only invariant.
- resolveRoutingKey mapping table (§3.2) — every row, both directions.
- **Rebuild-from-journal**: corrupt file → journal replay → ids (incl. thread-level +
  probed) equal pre-corruption; journal-gone fallback flagged with attention.
- Funnel: `id>0` → telegram; `id<0` resolved-local-origin → slack with thread_ts;
  `id<0` replicated-only-origin → NOT deliverable; `deterministicKind` set → gate-exempt path;
  non-owning-machine → typed failure; **dryRun → typed non-delivery (NOT success) + audit
  line**; **permanent-error set is exactly `{is_archived, channel_not_found, not_in_channel}`
  — each flips `reachability` + dead-letters; distinct from the adapter's token-scoped
  `SlackApiError.permanent`**; **an unrecognized permanent-shaped Slack error → treated
  transient + ONE deduped attention item (drift canary, L5)**; reachability flip is
  idempotent (already-unreachable → no write) + auto-clears on next success; **a peer-forged
  replicated `reachability:unreachable` NEVER terminates a live beacon on the owner (owner
  reads only its own locally-observed reachability)**; system-channel suppression preserved;
  opts pass-through (isProxy/dedup) per-arm.
- **Beacon survives + escalates a funnel typed failure** (fire() re-arm in finally; N-fail
  → raiseAttention) — the flagship-consumer safety test.
- **Burst-invariant (P17)**: 1,000 attention items on one minted id → bounded Slack messages;
  the per-conversation budget map evicts stale entries (bounded, not monotonic).
- Mint-rate breaker: over-budget conversation still delivers (in-memory candidate); a
  SPECULATIVE inbound registration is DROPPED (zero pending state) + re-mints on a later
  inbound; **a durable BINDING (commitment open) FORCES registration regardless of the
  speculative budget, but its OWN higher cap yields a typed capacity-refusal + attention item
  at the ceiling (never a silent drop — adversarial-B)**.
- **Bespoke replicated store + merge algebra §3.5.1** (§6.1 step 9) — the highest-criticality new
  component, so its merge gets EXHAUSTIVE coverage (gemini-R2/R3/R4 — the single highest test
  priority). Every §3.5 divergence case (placeholder-skew both orderings, out-of-order probed
  ingest, forged-origin, forged-reachability, seize) PLUS the round-2 merge-convergence cluster:
  - **Collision-deadlock fix (A1):** two DIFFERENT tuples whose candidates PROVABLY collide,
    minted in OPPOSITE order on two machines, converge to the SAME assignment (the `≺`-lesser
    tuple keeps the canonical, the other takes the key-derived offset) — NEITHER machine
    quarantines the record it needs; the seize-refusal does NOT fire on a collision-induced probe,
    and DOES fire on a genuine hijack (different tuple, id neither its candidate nor a within-bound
    offset).
  - **Content-deterministic HLC (A2):** an online receiver and an offline-then-returning receiver
    pick the SAME winner for the same record set (the compared `physical` is the RAW emitter value,
    never receipt-clamped); a forged `{physical:0}` is QUARANTINED on the absolute-window
    acceptance check, not mutated into a win.
  - **Arrival-order independence (A3):** a **fuzz test permuting arrival order across ≥3 machines
    asserts BYTE-IDENTICAL `resolve()` for every id**; a probed id never squats another tuple's
    canonical (held as a lower-priority alias candidate, re-resolved when the canonical arrives).
  - **Key-derived probe (A4):** the probe/displacement target is a pure function of the tuple set,
    independent of live local occupancy/alias state.
  - **Atomic winner-flip (A5):** three ids for one tuple arriving in EVERY permutation converge to
    a single winner with all losers as ONE-HOP aliases (no chains); a late lower-HLC demotion
    re-points every alias targeting the demoted id in ONE journaled op, idempotent under replay.
  - **Sticky canonical (R2-adversarial-1):** a LOCAL durable binding is opened on id C (a
    commitment binds → the `sticky` marker journals + replicates); an incoming COLLIDING foreign
    tuple with a LOWER HLC arrives → the binding still resolves to the victim's conversation on
    BOTH machines (C is never demoted; the newcomer is displaced to the step-2 walk); the
    sticky-vs-sticky partition case falls back to `≺` WITH the heal-forward repoint + ONE deduped
    attention item for the displaced binding (never a silent strand); a replicated `sticky:false`
    never clears a local `true` (monotonic).
  - **Skew-exemption / equal-R delivery (R2-adversarial-3):** an offline-then-RETURNING machine
    with a stale pool-relative reference ingests the same record set as an online peer and reaches
    byte-identical `resolve()` for every id (the conversations ingest is exempt from the
    pool-relative skew quarantine; a transport-quarantined record is RETRIED, never
    cursor-skipped).
  - **Forged `mintedBy`/`hlc.node` (B4):** cannot change the alias tiebreak winner (both are
    overwritten to the authenticated envelope origin on ingest).
  Plus: same-tuple/different-id → local alias, NEVER a foundation `recordConflict`;
  wiring-integrity regression asserts the 7 existing WS2 stores still surface conflicts unchanged;
  `adopted-replicated` copy witness-dominates (no self-conflict); a peer-forged
  `reachability:unreachable`/`origin` is neutralized on ingest.
- **Shared-hardening reuse (B5, R2-lessons-4):** a wiring-integrity/lint assertion that ALL
  conversations-store ingest routes through the ONE shared entry function
  (`normalizeConversationsIngest`), which INVOKES the shared exported primitives
  (`clampReplicatedRecord`, `validateEnvelope`, `hlcWithinAbsoluteWindow`) — an inline
  hand-rolled clamp, or a second ingest entry point, is a CI failure (no fourth copy).
- **Tuple index is O(1) (G1):** `byTuple`/same-tuple detection perform no linear scan over
  `conversations` (asserted against a large seeded store).
- **Journal single-writer (G3):** concurrent probed + durable mints in one tick produce strictly
  monotonic `seq` and never an interleaved/torn NON-tail record.
- **Poisoned-label sink (B3):** a poisoned replicated `label` is escaped on `GET /conversations`
  and NEVER reaches an un-escaped attention/beacon/notice/session-context sink (those carry the
  minted id + local channelId, not the replicated label).
- **Statistical collision (F3, R2-scalability-3):** the corpus is sized for statistical POWER —
  either mint near the 50%-knee (~55k real-shaped Slack channel + thread ids) and assert the
  measured collision count within the §3.3 birthday band, or apply a chi-square /
  bucket-occupancy uniformity metric over the hash outputs (a "thousands"-sized
  count-the-collisions corpus expects <1 collision and proves nothing); a material
  overshoot / non-uniformity is the §11.9 wider-space trigger.
- **Cross-conversation bind refusal (B7, R2-security-NEW-5):** a `POST /commitments` whose
  `topicId` is not the session's own bootstrap conversation (nor a positive id in its
  authenticated bootstrap context) is REFUSED (`conversation-bind-not-authorized`) + attention
  item, never delivered into the foreign thread — BOTH branches pinned: own bootstrap topic
  (positive or minted) → allowed; arbitrary foreign positive id → refused.
- **Recording-off bind refusal (R2-integration-§9):** with `recording.enabled:false`, a
  durable-state open on a MINTED id is refused (`conversation-recording-disabled`) + one deduped
  attention item; a positive Telegram bind still succeeds; re-enabling restores minted binds.
- **Mass-unreachable aggregation (R2-lessons-2):** N simultaneous permanent errors (bot removed
  from workspace) produce ONE aggregated attention item carrying the count + list — never N
  items (burst-invariant on the dead-letter emitter).
- **Gate-exempt allowlist (B2):** only the two blessed call sites pass a `deterministicKind`; a
  third is a CI failure; the arm's text is server-side-templated per kind.
- **Ambiguous-outcome idempotency (E1, R2-lessons-1 / R2-security-NEW-3 / R2-security-NEW-4):**
  an ambiguous `not-delivered` on an id<0 send that actually posted does NOT double-post — the
  per-`(conversationId, logicalSendId)` window suppresses the beacon's re-fire **at the REAL
  beacon cadence (the test re-fires at the beacon's actual re-fire interval, never a
  sub-window fast retry), with interpolated elapsed/liveness text differing between attempts
  (same logical send → still suppressed)**; the NEXT scheduled heartbeat (new send seq) is NOT
  suppressed; a CLEAN transient failure (5xx, never posted) is NOT recorded in the window and
  its retry is NOT suppressed (distinct from ambiguous → single post); the startup invariant
  `ambiguousDedupWindowMs ≥ max beacon re-fire interval` clamps UP + logs on violation; the
  dedup map is bounded/evicting (burst-asserted); `allowDuplicate` bypasses; brief acks never
  suppressed.
- **Dead-letter scoping (I1):** a non-owning-machine typed-failure NEVER increments the
  dead-letter counter; only an owning-machine real delivery failure does. And the multi-machine
  cliff (>1 machine + CommitmentsSync live + `stateSync.conversations` dark) raises exactly ONE
  deduped boot attention item.
- **WAL crash-consistency** (§3.4 contract): torn-tail line discarded on replay; replay is
  idempotent (re-run any number of times → same state); snapshot high-water bounds replay to
  the tail; a crash mid-append never corrupts an earlier record; a crash mid-replay re-runs
  cleanly.

**Tier 2 — integration** (full HTTP pipeline):
- `GET /conversations*` routes: list/resolve/health, 404 semantics, Bearer auth, label
  sanitized on render.
- `POST /commitments` with a minted id → beacon tick → funnel → mocked Slack adapter
  receives channel + thread_ts.
- `/telegram/reply/:topicId` 400-on-negative, classified terminal in relay/DFS.
- Inbound dispatch mint: synthetic Slack inbound → registry entry exists, session metadata
  carries `conversationId`, second message mints nothing new.
- migrateConfig NEVER writes `followThrough.enabled` / `stateSync.conversations.enabled` /
  `recording.enabled:false`; it DOES add `recording.enabled:true` when absent (D1).
- **Backup manifest contains BOTH entries and they RESOLVE (C1, R2-integration-1/-2):** after
  the migrator runs, `config.backup.includeFiles` includes `state/conversation-registry.json`
  AND the stateDir-relative glob `logs/conversation-registry.jsonl*`; after a durable mint,
  each manifest entry resolves (via the BackupManager's stateDir-join) to a REAL file on disk —
  a string-only/dead entry fails the test. NO pre-backup flush hook is asserted (dropped —
  WAL-in-backup covers the un-flushed window).

**Tier 3 — e2e "feature is alive"** (mirrors server.ts production init): boot the real
server wiring, assert `GET /conversations/health` answers **200, not 503**, adoption pass
ran, and a full inbound→mint→commitment→restart→beacon→delivery cycle completes against
the fixture adapter. The single most important test in the spec.

**Wiring integrity**: ctx.conversationRegistry non-null in the production init path; the
former hash callsites delegate to the ONE export — a grep-ratchet lint SCOPED TO THE MINT
IDIOM `-(Math.abs(<hash>) + 1)` (NOT the bare `(hash<<5)-hash` literal, which also appears
in `TelegraphService.ts:530` for unrelated change-detection — security-m1) makes a fourth
mint copy a CI failure.

**Live proof — the FULL scenario matrix** (roadmap clause, test-as-self on the dev agent against
the Slack live-test workspace). The Live-User-Channel-Proof standard requires ALL categories, not
just happy-path + lifecycle (F1); a signed PASS/FAIL matrix is recorded BEFORE "done." Volatile/
permission scenarios run on throwaway channels, never the live operator channel:

| Category | Scenario |
|---|---|
| **Happy-path** | Post in a thread in a test channel → agent commits "I'll report back in 10 minutes" (visible in `GET /commitments` with the minted id) → beacon heartbeat arrives IN THAT THREAD. |
| **Lifecycle** | Restart the server mid-commitment → beacon still fires into the same thread post-restart (durable-id proof). |
| **Channel-parity** | The SAME flow at CHANNEL level and at THREAD level both deliver to the correct granularity; a Telegram commitment (positive id) is unaffected (funnel `id>0` arm). |
| **Failure/rollback (F2 — REAL Slack API)** | ARCHIVE a live test channel via the real Slack API → confirm the code the API actually returns is in the pinned permanent set `{is_archived, channel_not_found, not_in_channel}` (closes the mock-encodes-wrong-code trap) → the entry's `reachability` flips to `unreachable` → the beacon dead-letters to ONE attention item (not an infinite retry). Un-archive → next success auto-clears `reachability` to `ok`. |
| **Permission/volatile** | Remove the bot from a channel → `not_in_channel` → same permanent classification + dead-letter, on a throwaway channel. |
| **Concurrency (replicated increment)** | Two dev machines mint the SAME tuple concurrently → after replication, both resolve the id to a single conversation with the loser as a one-hop alias (deterministic §3.5.1 convergence, observed on BOTH machines). |
| **Idempotency** | An ambiguous-outcome send (force a lost ack) → the beacon re-fire produces a SINGLE post in the thread, not a double (E1 guard). |
| **Regression** | Existing Telegram commitments + beacons still deliver unchanged; the golden-parity ids are byte-identical to pre-refactor. |

## 11. Non-goals (blast radius kept honest)

1. **Slack outbound robustness** — queue/retry/dedup/idempotency/formatter/
   DeliveryFailureSentinel lane (roadmap Phase 2.1, tracked in the ratified roadmap under
   topic 29836 — Deferral=Deletion honored). The funnel delivers with `/slack/reply`'s
   current guarantees plus the §5.1 permanent-error classification.
2. **SlackLifeline instantiation** and **socket-follows-lease / Slack exactly-once ingress
   ledger** (Phase 2.2 — tracked in the ratified roadmap under topic 29836, same re-surfacing
   cadence as §11.1; R2-lessons-3). The registry provides the key they will use; the Phase-2.2
   ledger
   MAY key on the canonical key or `(channel, ts)` — `dedupeKeyFor` accepts either; nothing
   here constrains it. **The active-active lease-holder ↔ conversation-owner reconciliation**
   (which machine's beacon delivers a minted Slack id when the lease holder is not the
   socket holder — integration-F2) is ALSO a Phase-2.x follow-up here; in single-Slack-machine
   deployments the two coincide, so §5.1's dead-letter is never armed on a by-design
   non-owning refusal today.
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
   for shared channels — reserved-note so Phase 7.1 doesn't inherit a trap. **Anchored to the
   roadmap's Phase-7.1 entry (topic 29836) so the deferral re-surfaces on the roadmap cadence,
   not by memory (R2-lessons-6).**
9. **A wider (48-bit) candidate space + full decoupling from the legacy hash**
   (gemini-G1, codex-R4-2): the legacy 32-bit hash is a TRANSITIONAL dependency (the mint
   CANDIDATE, with the registry as the collision authority). It is DELIBERATELY kept for Phase
   1 because it is what buys zero-loss adoption of the existing channel-level corpus AND
   coordination-free mixed-fleet skew convergence — both hard requirements TODAY. The wider
   space is the natural **Phase-7.2 companion**: Phase 7.2 (thread-routing default ON) is
   precisely what makes thread-level mints common and thus makes the 31-bit birthday pressure
   (§3.3 table) matter — and thread-level ids have NO legacy corpus to adopt, so a wider space
   for NEW thread/non-legacy mints there breaks nothing (channel-level ids keep the legacy
   candidate for zero-loss). The scale mitigation is thereby tied to the exact phase that
   creates the scale, not carried as unbounded debt: until 7.2, thread mints are ~zero
   (thread routing is disabled by default), so the 31-bit space is not a live risk.
10. **Registry compaction/GC + the SQLite migration target** — bounded-by-usage; never deletes
    (identity resolves forever). The §3.4 append-journal-as-primary / **SQLite migration** (the
    honestly-justified §3.7 target) is the planned scale move at the ~50k-entry / ~10MB ceiling,
    tracked here so 100k entries is a scheduled move — landing BEFORE the ceiling, not at it
    (scalability-G2) — not an incident.
11. **A registry dashboard render surface** — Phase 1 renders labels ONLY via `GET /conversations`
    (escaped). A dashboard tab is a Phase-2.x follow-up (B3) and inherits the escape-on-render
    label test when it lands; no dashboard surface exists to sanitize meanwhile. **Anchored to
    the roadmap's Phase-2.x list (topic 29836) for the re-surfacing cadence (R2-lessons-6).**

## Frontloaded Decisions

1. **Minted numeric id over typed-union** — §2, evidence-forced (168 files, 3 SQLite
   INTEGER schemas, deployed negative-id convention, zero-loss skew requirement).
2. **Legacy hash as deterministic mint candidate; probe direction DOWN (`id -= 1`),
   FROZEN forever; alias ids count as occupied during a probe; the local mint applies the
   FULL §3.5.1 displacement rule including step 2(b)'s collision-class taken-offset set,
   via ONE shared implementation with the merge** — §3.3 (R2-adversarial-2).
3. **Identity = structured tuple `(platform, channelId, threadTs)` + minted id; the
   canonical key is its normalized lookup string; workspaceId is upgradable metadata,
   never the identity core** — §3.1.
4. **Thread identity = resolveRoutingKey verbatim** — §3.2 (a new thread on an old message
   is a new conversation at first reply); threadSessions mode-flip surfaces a deduped
   operator notice when open commitments exist.
5. **`_`→teamId upgrade in place, triggered ONLY by the local authenticated adapter,
   never by replicated data** — §3.1.
6. **Cross-machine identity = the structured tuple, not the key string; the MERGE IS A PURE
   FUNCTION OF THE RECORD SET (§3.5.1 — collision-class canonical reservation, key-derived
   probe, atomic winner-flip). Same-tuple/`_`-vs-real teamId is a metadata upgrade, but only a
   LOCALLY-authenticated concrete teamId rewrites the workspace (a replicated concrete is
   advisory/quarantined-if-divergent — never a seize). Same-tuple/different-id auto-resolves by
   RAW-HLC (never receiver-clamped) + alias, tiebreak on authenticated-envelope machineId.
   Different-tuples-that-provably-collide resolve deterministically from the tuple pair (a merge,
   not a seize); different-tuple/same-id with NON-colliding candidates is the ONLY seize —
   refused. Aliases are LOCAL-only, never ingested. A DURABLY-BOUND id is NEVER demoted (the
   §3.5.1 `sticky` marker — R2-adversarial-1); the `≺` tiebreak reads the IMMUTABLE tuple
   byte-form, never the mutable key string (R2-adversarial-4); the conversations ingest is
   EXEMPT from the pool-relative skew quarantine (its absolute HLC window is the
   machine-independent gate — R2-adversarial-3)** — §3.5, §3.5.1.
7. **Replicated entries are advisory until locally corroborated; delivery resolves ONLY
   local-origin entries; every locally-bound entry is copied into the local origin
   (adopted-replicated) so un-merge can't orphan it** — §3.5.
8. **The conversations store is a BESPOKE replicated store keyed on the minted id, doing
   its own tuple-first merge + local alias derivation — NOT a standard ReplicatedStoreReader
   consumer, so it needs ZERO foundation change and touches no shared conflict machinery
   (the 7 WS2 stores are byte-unaffected); precedent TopicPinReplicatedStore.mergeUnionToPins;
   built as an explicit dark/dev-gated increment (§6.1 step 9)** — §3.5.
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
17. **Durability model = journal-as-WAL: a PROBED or durable-binding-forced mint append+fsyncs
    ONE journal line BEFORE returning the id; the O(N) full-store snapshot stays batched; a
    pure speculative non-probed mint rides the snapshot only (re-mints deterministically). The
    local probe loop is bounded by `MAX_PROBE_DISTANCE=64` (= the ingest bound). Zero-loss
    adoption is claimed ONLY for channel-level ids (the inventory of durable negative-id
    stores); thread-level ids re-mint on next inbound or restore via the WAL.** — §3.3, §3.4.

## Open questions

*(none — both prior entries were non-goals already tracked in §11.4 (Slack attention ack
UX → Phase 2.3) and §11.2 (Phase-2.2 ledger keying); relocated there, no live user-decision
remains.)*

## Appendix A — Reviewer provenance (read the body for the design; this is only traceability)

The inline parenthetical tags in the body — `(codex-Xn)`, `(security-Mn)`, `(adversarial-An)`,
`(scalability-Gn)`, `(integration-Fn)`, `(gemini-Cn)`, `(lessons-Fn)`, and the letter-only
`(A1)`…`(I1)` refs — are **traceability markers to the review round that surfaced each
constraint**, not part of the design logic. A reader implementing the spec can ignore them; the
prose beside each tag is self-contained and implementation-oriented. They are retained (rather than
stripped) so a later review round can verify every finding landed, and so a future maintainer can
trace WHY a non-obvious invariant exists back to the failure or review that earned it. The
letter-coded refs (`A1`–`A7` merge-algebra, `B1`–`B8` security, `C1`–`C3` durability, `D1`
kill-switch, `E1` idempotency, `F1`–`F3` proof/testing, `G1`–`G4` scalability, `H1` conformance,
`I1` ownership) map to the Round-1 convergence findings this Phase-2 rewrite resolved; the
merge-algebra cluster (`A1`–`A7`) is the load-bearing one — it is what makes the cross-machine
merge a pure function of the record set (§3.5.1). Tags prefixed `R2-` map to the Round-2
findings resolved by the Round-3 revision (Appendix B). Provenance lives here; the design lives
above.

## Appendix B — Round-3 revision log (Round-2 findings → resolutions)

Applied from `docs/specs/reports/durable-conversation-identity-round2-findings.md`; every tag
below is traceable inline as `R2-<finding>`.

| Finding | Resolution |
|---|---|
| HIGH adversarial-2 (local mint omits merge step 2(b)) | §3.3 `candidateCollides` gains clause (c): a per-collision-class `≺`-ordered taken-offsets set — local mint and §3.5.1 step 2 share ONE displacement implementation, §10 equivalence-tested. |
| HIGH integration-1 (journal path ambiguous between two log roots) | §3.4 journal-path PIN: `<stateDir>/logs/conversation-registry.jsonl`; backup entry = stateDir-relative glob `logs/conversation-registry.jsonl*`; Tier-2 asserts manifest entries resolve to REAL files; §8/§6.2/§3.3 references updated. |
| HIGH lessons-1 (E1 window < beacon cadence; unstable content-hash key) | §5.0(a): window pinned as startup-asserted invariant `≥ max beacon re-fire + margin` (default 30 min); key = `(conversationId, logicalSendId=commitmentId+sendSeq)` with content-hash fallback; §10 test runs at the REAL beacon cadence with interpolated-text drift. |
| MEDIUM scalability-1 (`candidateCollides` not pinned O(1)) | §3.3: each clause pinned O(1) (reserved-canonical lookup, alias lookup, bounded per-class set); §10 no-linear-scan assertion extended to the probe path. |
| MEDIUM security-NEW-3 (dedup entry recorded on attempt suppresses failed retry) | §5.0(a): entry recorded ONLY on success or ambiguous/ack-lost — never a clean transient failure; §10 pins the transient-vs-ambiguous distinction. |
| HIGH adversarial-1 / security-NEW-1 (collision-demotion strands a durable binding) | Sticky canonical: §3.5.1 `sticky(t)` marker (journaled + replicated, boolean-clamped, monotonic) — a durably-bound id is NEVER demoted; newcomers displaced; sticky-vs-sticky partition case falls back to `≺` + heal-forward repoint + ONE deduped attention; §3.4 entry field + §10 tests. |
| MEDIUM adversarial-3 (pool-relative skew quarantine breaks equal-R premise) | §3.5.1: conversations ingest EXEMPT from the pool-relative skew quarantine (the absolute HLC window is the machine-independent gate); any transport-quarantined record is RETRIED never cursor-skipped; §10 returning-machine test. |
| MEDIUM security-NEW-2 (replicated workspacePin is first-writer/attacker-controlled) | §3.1: a purely-replicated pin needs ≥1 LOCAL authenticated corroboration before fail-closing; local authenticated teamId takes precedence; divergence quarantines + attention; config pin documented as strongly preferred. |
| MEDIUM lessons-2 (mass dead-letters not emitter-aggregated) | §5.1: terminal dead-letters aggregate at the emitter into ONE summary item per coalescing window; §10 burst-invariant test. |
| MEDIUM integration-2 (pre-backup flush hook has no mechanism, redundant) | DROPPED (preferred option): no flush hook anywhere; WAL-in-backup covers the un-flushed window; §3.4/§6.2/§10 updated. |
| MEDIUM lessons-3 (unscoped "always reachable on Slack"; §11.2 cadence) | §6.1-3 scope-honesty note (floor holds only while the Slack transport is up); §11.2 anchored to the roadmap/topic-29836 cadence. |
| LOW security-NEW-4 / scalability-2 (dedup map unbounded) | §5.0(a): reuses the AttentionTopicGuard bounded/evicting structure; burst-tested. |
| LOW security-NEW-5 (positive-id bind branch under-specified) | §7: "bound to" defined as presence in the session's authenticated bootstrap context (symmetric with the minted-id rule); §10 pins both directions. |
| LOW security-NEW-6 (`workspaceId` missing from clamp allowlist) | §3.5 type-clamp: `workspaceId` shape-clamped `^T[A-Z0-9]+$` or `_`. |
| LOW adversarial-4 (`≺` tiebreak on mutable key string) | §3.5.1 + §3.5: tiebreak reads the IMMUTABLE tuple byte-form `(platform, channelId, threadTs)`. |
| LOW adversarial-5 (convergence-totality unbounded claim) | §3.5.1 totality-honesty bullet: bounded by `MAX_PROBE_DISTANCE`; ≥64-deep genuine chain → pending-mint, non-convergent across unequal R until sets equalize. |
| LOW scalability-3 (F3 statistical test underpowered) | §3.3 + §10: corpus at the ~55k 50%-knee OR a chi-square/bucket-occupancy uniformity metric. |
| LOW scalability-4 (batched flush blocks the event loop) | §3.4 event-loop honesty: "delivery never waits" scoped to the mint hot path; upper-envelope flush moves off the event loop (async/worker write); SQLite retires it. |
| LOW lessons-4 (lint can't verify absence-of-copy) | §3.5: ONE shared ingest entry fn (`normalizeConversationsIngest`); lint verifies invocation; a second entry point is a CI failure. |
| LOW lessons-5 (WAL under-verifiable by SIGKILL tests) | §3.7 verification-residual note; named as a reason to bring the §11.10 SQLite migration forward on evidence. |
| LOW lessons-6 (§11.8/§11.11 deferrals lack cadence) | Both anchored to the roadmap (topic 29836) re-surfacing cadence. |
| LOW integration-§9 (recording:false can orphan a durable bind) | §9/§3.6/§10: durable binds on minted ids REFUSED (typed `conversation-recording-disabled`) while recording is off; claim narrowed honestly; positive Telegram binds unaffected. |
| codex-R2-1 (replication key conflict under-specified) | §3.5: record namespace made precise — `(origin, id)` per-origin envelopes consumed directly by the bespoke merge; a same-id claim from two origins never collides at the transport layer. |
| codex-R2-2 (`_` mints can breach single-workspace pre-pin) | §3.1: a REPLICATED `_`-placeholder entry is held out of the same-tuple cross-machine merge until the fleet pin confirms (advisory-only meanwhile, which it already was). |
| codex-R2-3 (duplicate id ownership during merge recompute) | §3.5: claimed-vs-resolved split pinned — raw `(origin, id)` records are claim inputs; `resolve()`/the reverse index read ONLY the derived §3.5.1 assignment output. |
| codex-R2-4 (WAL becoming a bespoke database) | Addressed via R2-lessons-5 (§3.7 verification residual + SQLite-sooner trigger); the WAL stays deliberately minimal. |
| codex-R2-5 (gate-exempt templates still a privileged path) | §5 B2 strengthened: compile-time enumerated template ids + schema-validated substitution fields + §10 substitution-injection test. |
