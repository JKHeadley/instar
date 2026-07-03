---
title: "Durable, Channel-Agnostic Conversation Identity (the Phase-1 structural refactor): Spec"
slug: "durable-conversation-identity"
author: "echo"
status: "draft"
parent-principle: "Structure beats Willpower — durable identity must be a registry, not a convention three copies of a hash function remember"
sibling-principles: "The Agent Is Always Reachable — A Guaranteed Reachability Floor; Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions; Know Your Principal — An Unverified Identity Is a Guess; A Refusal Stays a Refusal; Bounded Notification Surface (P17); Migration Parity; Close the Loop (Untracked = Abandoned); Bounded Blast Radius"
lessons-engaged: "Structure beats Willpower (one registry, not three hashes) · Maturation Path — Every Feature Ships Enabled on Developer Agents (§9 dev-gated ladder) · The Agent Is Always Reachable, corollary 2 (§5 deterministic reachability arm) · A Refusal Stays a Refusal / P18 (§5 dryRun returns typed non-delivery, never success-shaped) · Bounded Notification Surface P17 (§5 funnel per-conversation + GLOBAL budgets + burst tests; §3.5 ingest-refusal aggregation) · Bounded Blast Radius (§3.3 mint-rate breaker) · Cross-Machine Coherence (§3.5 local-origin adoption; §5 owning-machine delivery) · Know Your Principal (§7 replicated entry is advisory, never delivery authority) · Migration Parity (§9 migrateConfig never materializes enabled:false; migrateClaudeMd) · Deferral = Deletion / Close the Loop (§11 Phase-2.1 tracked) · P7 LLM-Supervised Execution (§6.2 Tier 0 justified; declared in the `supervision` frontmatter key) · P14 Distrust Temporary Success (§3.3 birthday math honest; §6.2 journal-replay rebuild) · Convergent Merge Algebra [constitution standard] — the merge is a pure function of the record set (§3.5.1 collision-class canonical reservation; content-deterministic HLC compared value never clamped; atomic idempotent winner-flip; key-derived probe sequence against ONE GLOBAL taken set spanning all collision classes — R4-C1; durable-binding protection is a LOCAL delivery-time overlay §3.5.2 that also rides the binding record as `boundTuple` (R4-M1), NEVER a merge input — R3-C1/C2/C3) · Disaster-Recovery Completeness [spec-local shorthand] (§3.4/§6.2 both the JSON snapshot AND the journal enter the backup manifest, via a glob shape the DEPLOYED expandGlob actually resolves — R3-C4) · Ambiguous-Outcome Idempotency [spec-local shorthand] (§5 id<0 logical-send-identity dedup ships WITH the funnel; suppression is retirement-based, never a fixed window racing the real 6h beacon backoff — R3-M1/M2) · Reuse over Re-implementation [spec-local shorthand of the parent principle] (§3.5/§4 shared foundation hardening primitives — no third hand-rolled copy of clamp/HLC; §3.4 backup rides the deployed glob resolver rather than extending it) · Runtime Kill-Switch [spec-local shorthand of the CommitmentTracker-freeze lesson] (§9 recording.enabled off-switch honors the freeze precedent)"
supervision: "tier0 — the registry rebuild, journal replay, and §3.5.1 bespoke merge are byte-deterministic pipelines with no judgment call to wrap (rationale §6.2); the DECLARED supervisor-equivalent is the §10 golden-parity + deterministic-convergence + fuzz suite. All other pipelines this spec touches (beacon delivery, attention) keep their existing supervision tiers."
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

### 3.0 Normative core (the five contracts — codex-R3-#5 / gemini-R3-#1)

The full sections below carry provenance tags and defense-in-depth detail; a large audit
surface invites drift. These five contracts are the NORMATIVE core — everything else in §3–§6
is an elaboration of one of them, and a §10 test pins each. Provenance markers (Appendix A)
are non-normative traceability, never design input.

1. **Identity model.** A conversation IS the structured tuple `(platform, channelId,
   threadTs?)`, bound once to a stable negative minted id; the canonical key string is its
   lookup form; `workspaceId` is upgradable metadata under a single enforced workspace (§3.1).
   Telegram positive ids pass through unregistered, forever.
2. **Mint.** `candidate = -(abs(hash(routingKey)) + 1)`; collisions probe DOWN through the
   frozen offset sequence under the ONE shared displacement implementation (§3.3 = §3.5.1
   step 2); probed and durable-binding mints fsync ONE journal line before the id is returned.
3. **Merge.** Id assignment is a **pure function of the ingest-accepted record set R**
   (§3.5.1): canonical reservation by `≺`, key-derived displacement, one-hop aliases, no
   local-lifecycle input of any kind. R governs registry SHAPE only.
4. **Delivery.** Delivery authority is LOCAL: only local-origin entries deliver (§3.5 KYP),
   the owning machine delivers (§5.0), and a live durable binding's delivery is protected by
   the LOCAL bind-pin overlay (§3.5.2) — journaled, NEVER replicated through the registry,
   NEVER a merge input; on an ownership migration the pin is reconstructed from the binding
   record's own `boundTuple` (§3.5.2 property 5 — R4-M1), never from the registry wire.
5. **Recovery.** Backup restore (snapshot + journal glob, both in the manifest in a shape the
   deployed resolver expands — §3.4) → journal replay (`seq` global-monotonic past the
   snapshot high-water) → deterministic re-mint as last resort with the documented probe-order
   risk (§6.2).

**The §10 merge fuzz suite (≥3 machines, permuted arrival, byte-identical `resolve()`) is the
committed practical defense against the merge's implementation-complexity surface** — it is
the one test class treated as critical-path for the increment-9 graduation, alongside the
statistical hash test whose measured result drives §11.9 timing (gemini-R3-#3).

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
  sourced, may be `undefined`). **Honesty note (R3-minor — "authenticated `getWorkspaceId()`"
  elsewhere in this spec means THIS accessor, which today is a CONFIG read
  (`this.config.workspaceId`), not a live API assertion.** A concrete teamId materializes at
  runtime only from config (or a future `auth.test`/event-envelope source when one is wired);
  where config is the only source, the §3.1 source-2 replicated-pin corroboration collapses
  into source-1 and the `_`-upgrade machinery is largely dormant — correct but idle, stated
  plainly so no reader over-credits the word "authenticated.") When genuinely unknown, the placeholder `_` is used AND
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
- **Phase-1 single-workspace enforcement, stated at its REAL strength (codex-X2a,
  codex-R4-1; reconciled per R3-M9 — the earlier "fleet-wide hard-refuse" claim contradicted
  the R2-security-NEW-2 keep-minting-locally rule).** This phase supports exactly ONE Slack
  workspace per fleet. Enforcement has two honest layers, and the spec no longer claims more:
  - **Per-machine (always):** each machine hard-refuses to mint for a second distinct
    CONCRETE `workspaceId` relative to ITS resolved pin (typed `multi-workspace-unsupported`
    refusal, below). One machine can never mint two workspaces.
  - **Fleet-wide (structural only WITH a config pin):** with no config pin, two machines
    authed to different workspaces DO each keep minting under their own local authenticated
    teamId (the deliberate R2-security-NEW-2 anti-DoS posture) — per-machine minting with a
    loud pin-conflict attention item, NOT a fleet-wide refusal. Therefore, **in multi-machine
    mode the config-declared `workspacePin` is MANDATORY for cross-machine identity**: at
    boot, when `>1` machine is registered in the pool AND a Slack adapter is configured AND
    `conversationIdentity.workspacePin` is absent, the `stateSync.conversations` emitter
    HOLDS all concrete-workspace entries out of replication (they stay machine-local;
    `_`-placeholder handling unchanged) and ONE deduped boot attention item names the fix
    ("set conversationIdentity.workspacePin to replicate Slack conversation identity").
    A single-machine agent never reaches this gate.
  - **The load-bearing uniqueness assumption, stated explicitly (R3-M9 / codex-ext-#1):**
    the v1 tuple has no `workspaceId`, so tuple identity is sufficient ONLY because channel
    ids are unique WITHIN the one pinned workspace (a Slack guarantee). **Global cross-
    workspace channel-id uniqueness is NOT assumed** — that is precisely why concrete-
    workspace entries never replicate across an un-pinned multi-machine fleet (above), and
    why Slack Connect / Enterprise Grid shared channels (one channel id visible from multiple
    workspaces) remain a typed refusal deferred to Phase 7.1 (§11.8), where `workspaceId`
    enters the identity core as tuple schema-version 2.
- **The workspace pin is a FLEET-CONSISTENT value, NOT "first concrete teamId seen locally"
  (A6 — a per-machine first-seen pin can diverge, so one machine would refuse a mint another
  accepts, breaking convergence).** The pin resolves in this fixed order, identical on every
  machine:
  1. **Config-declared** `conversationIdentity.workspacePin` (a concrete teamId in
     `.instar/config.json`) is authoritative when present — the deterministic, coordination-
     free source.
  2. **Absent config**, the pin is a **replicated pin CANDIDATE, corroboration-gated (R4-minor-5
     — the earlier "replicated single-writer fleet value" name over-promised: the fleet does
     not necessarily USE one value; under conflict each machine keeps minting under its own
     locally-authenticated teamId, per the rules below — an implementer must NOT build this as
     an actual single-writer register)** stored as
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
    append one journal line to <stateDir>/conversation-registry.jsonl (the §3.4
    journal-path PIN — stateDir ROOT) through the SINGLE-WRITER journal serializer
    (§3.4 G3) and fsync BEFORE returning id
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
  (c) `id` is a displacement offset ALREADY TAKEN by ANY `≺`-earlier displaced tuple — checked
  against **ONE GLOBAL displaced-assignment set spanning ALL collision classes (R4-C1 — the
  round-3 per-class wording was UNSOUND: adjacent collision classes whose probe walks overlap
  would each see an empty per-class set and assign the SAME id to two different tuples — a
  convergent-but-wrong state both machines compute identically, and adversarially
  constructible with 3 crafted records inside the accepted M7 threat model)** — §3.5.1 step
  2(b) applied locally. The registry maintains the live global set of taken displacement
  offsets (plus per-class claimant sets as the LOCATOR only, §3.4); two tuples colliding at
  one candidate — or at ADJACENT candidates within `MAX_PROBE_DISTANCE` — therefore probe to
  DISTINCT ids locally, in exactly the assignment §3.5.1 would compute (without a global (c),
  a same-class pair would probe to the SAME next id, and a cross-class pair whose walks
  overlap would too — either way the local reverse index would be silently overwritten:
  cross-conversation mis-resolution on a SINGLE machine, before any replication).
  It is **NOT** made true merely because a *probed* peer entry happens to occupy `id` via a raw
  occupancy check (that would re-introduce the Round-1 occupancy-dependent-probe HIGH): a
  probed entry never squats another tuple's canonical id (§3.5.1), so the walk-down sequence a
  machine follows is the frozen offset sequence `candidate, candidate-1, candidate-2, …`
  filtered ONLY by the reserved canonicals + the alias table + the GLOBAL `≺`-ordered
  displaced-assignment set (R4-C1) — each a pure function of the tuple set that every machine
  computes identically. **§3.3 local mint and §3.5.1 merge step 2 MUST share ONE implementation
  of this displacement rule (a single exported function), pinned by a §10 equivalence test**
  (the same tuple set fed to the local prober and to the merge yields byte-identical
  assignments). **Each check in `candidateCollides` is O(1) — a reverse-index/reserved-canonical
  lookup, an alias-table lookup, and a membership probe of the GLOBAL displaced-assignment set
  (a hash-set lookup; the set's SIZE is the total displaced-tuple count, but each CHECK is
  O(1)) — NEVER a live-tuple scan (R2-scalability-1);** §10 extends the no-linear-scan
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
materialize) — **option (b)'s parameters are PINNED (R3-minor, previously a builder guess):
≥10,000 real-shaped ids hashed into ≤4,096 buckets, uniformity rejected at p < 0.01; an
implementation that cannot meet those parameters MUST use option (a) instead.** A material
overshoot / non-uniformity verdict is the concrete TRIGGER to
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
- **The breaker's own per-channel budget-state map is BOUNDED (R3-minor).** It reuses the
  same bounded/evicting structure as the §5.2 budget maps (hard cap + stale-source eviction) —
  never a monotonic map keyed by every channel ever seen; symmetric with the E1/P17 maps.
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
conversation; only if the candidate is free/its-own does it deliver on the raw candidate.
**When NEITHER colliding tuple is registered (R3-minor — the degraded read would have nothing
to consult), flood-path delivery routes on the TRANSPORT sessionKey the inbound arrived on —
the reply goes back where the message came from, no minted-id read involved at all** (the
funnel's `id<0` arm is only ever entered with a registered or candidate id in hand). ONE
deduped attention item names the episode. `GET /conversations/health` surfaces the entry count
and file size with a threshold attention item (the tripwire before the §3.4 growth cliff).

### 3.4 Storage

`state/conversation-registry.json` — house-style JSON store: atomic tmp→rename writes,
single-writer serialized `mutate()` (the CommitmentTracker/TopicProfileStore CAS
pattern), in-memory cache authoritative for reads, corrupt-file quarantine-aside with the one
deduped attention item (the TopicPlacementPinStore pattern). **The FULL in-memory index
inventory (R3-M4 — the earlier "two indexes" undercounted what §3.3/§3.5.1 require; a faithful
implementer following a two-index list would produce a probe path that scans or misses
clauses (a)/(c)):**

Maintained SYNCHRONOUSLY at assign time (same tick as the id assignment — the O(1) hot path,
scalability-G1):
1. **id→key reverse index** (replacing the old `slackProxyChannelMap`) for `resolve(id)`;
2. **tuple→entry index** `Map<tupleKey, entry>` (`tupleKey = platform + '\x1f' + channelId +
   '\x1f' + (threadTs ?? '')`) for mint idempotency (`byTuple`) and same-tuple detection on
   EVERY inbound.

Maintained as DERIVED indexes — **rebuilt at boot from snapshot+journal, NEVER persisted**
(they are pure functions of the record/entry set):
3. **reserved-canonical map** (`cand → owning tuple`) — §3.3 `candidateCollides` clause (a);
4. **the GLOBAL displaced-assignment set** (`offset → owning displaced tuple`, one ORDERED
   structure spanning ALL collision classes — clause (c) as corrected by R4-C1; ordered so the
   §3.5.1 cascade can range-query "which displaced assignments fall in `[o, o+64]`" in
   O(log n + answers)). The round-3 per-class taken-offsets sets are RETIRED as an occupancy
   structure — per-class state survives only as the locator (index 5);
5. **cand→claimants multimap, ORDERED on `cand`** — the §3.5.1 merge's incremental-recompute
   locator (R3-M3, as restated by the R4-C1 bounded cascade): an ingested record's own
   collision class is found here in O(1); the classes a changed offset `o` can cascade to are
   exactly those with `cand ∈ [o, o + MAX_PROBE_DISTANCE]`, found by an ordered range query
   over this map's key space in O(log n + answers).

A faithful implementer must NOT realize any of these as a scan of `conversations`. §10 pins a
Tier-1 assertion that `byTuple`/same-tuple detection AND the probe/merge paths perform no
linear scan. **Resident-heap honesty:** with ~5 O(N)-adjacent maps (indexes 3–5 are
sparse — only collision classes populate them), resident heap is plausibly **5–10×
`fileSizeBytes`** at the 100k envelope; `GET /conversations/health` reports `entryCount` as
the heap axis with that multiplier documented, not the file size alone. Entry shape:

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
      // NOTE (R3-C1/C2/C3): there is NO `sticky` / durable-binding field on the entry and NO
      //   such field in the replication record. Durable-binding protection is the LOCAL,
      //   non-replicated bind-pin overlay (§3.5.2) — journaled (op:"bind-pin"/"bind-release"),
      //   never a merge input, never on the wire. The round-3 sticky marker is REMOVED.
      "hlc": { "physical": 0, "logical": 0, "node": "…" },  // the emitter-ticked record HLC; the §3.5.1 winner-tiebreak clock. `physical` is MILLISECONDS since the Unix epoch (frozen, schema-v1 — R3-M10). Its value is the RAW emitter value — the convergent comparison NEVER reads a clamped/mutated value (A2). Anti-forgery is an ACCEPTANCE check on ingest (out-of-absolute-sanity-window ⇒ quarantine), not a mutation of the compared field.
      "label": "#engineering"            // display-only, refreshable, UNTRUSTED peer data — neutralized/escaped at EVERY sink (§3.5 B3), or excluded from that sink
    }
  },
  "aliases": { "-83921478": -83921477 },  // divergence repairs — LOCALLY derived only (§3.5)
  // Snapshot-persisted journal-applied state (the §3.4 completeness corollary — R4-M2):
  // live bind-pins (§3.5.2) and UNRETIRED ambiguous-send dedup entries (§5.0(a)) are part of
  // the snapshot, so pruning fully-superseded journal files can never lose them. Both are
  // LOCAL state — neither is ever emitted into a replication record.
  "bindPins": { "-83921477": { "tuple": ["slack", "C0BA4F4E0FP", null], "refcount": 1 } },
  "ambiguousSends": { "-83921477cmt-42:7": { "recordedAt": "2026-07-02T21:03:00.000Z" } }
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
  `<stateDir>/conversation-registry.jsonl` (the §3.4 journal-path pin) BEFORE the id is handed
  to the durable consumer**
  (codex-R3-1/scalability-N1/adversarial-A/security-1: the ids that are NOT deterministically
  re-derivable after a hard crash — probed ids lose their order, forced bindings may be
  thread-level — must be on disk before a commitment binds to them; §6.2 replay restores
  them). The journal append is O(1) (append-only line), NOT the O(N)
  `JSON.stringify`+`writeFileSync` that caused the freeze — so this reintroduces NO whole-file
  write on the hot path. Only the full-store `saveStore()` SNAPSHOT is deferred/batched;
  `mutate()` is used purely for the snapshot, not for id assignment. Queue overflow (the
  CommitmentTracker `MUTATE_QUEUE_MAX_DEPTH=256` precedent) degrades to the §3.6 pending-mint
  path. Returning a raw candidate BEFORE synchronous assignment is reserved strictly for the
  registry-*unavailable* path (§3.6), whose heal repairs the affected binding FORWARD via the
  §3.5.2 bind-pin overlay (delivery follows the binding's tuple; the stored id is never
  mutated) — never by aliasing onto a live foreign id (which §3.5 would refuse anyway).
- **Snapshot cadence is SIZE-ADAPTIVE (scalability-G2).** Batching cuts snapshot FREQUENCY,
  but each flush is still an O(N) full-store `JSON.stringify`+write — the CommitmentTracker
  freeze SHAPE, just periodic. So the batch interval BACKS OFF as `entryCount` grows
  (`flushIntervalMs = clamp(baseIntervalMs × ceil(entryCount / adaptiveStep), baseIntervalMs,
  maxIntervalMs)`; pinned defaults `baseIntervalMs = 2000`, `adaptiveStep = 5000` entries,
  `maxIntervalMs = 60000`) so `per-flush-stall × frequency` stays bounded as the store grows.
  **Event-loop honesty (R2-scalability-4):** the batched flush itself still executes an O(N)
  `JSON.stringify`+write on the SHARED event loop — so the "delivery never waits on the O(N)
  write" claim is scoped precisely to the MINT HOT PATH (id assignment + journal append),
  never to the process as a whole. At the upper envelope — **pinned trigger (R3-minor,
  previously unpinned; a compliant impl would otherwise never ship the off-loop write before
  49,999 entries): `entryCount > 20000` OR the last serialized snapshot `> 2 MB`** — the
  flush serialization moves OFF the event loop (async write of a pre-serialized
  buffer, or a worker-thread stringify — the cartographer detect-in-worker precedent); the
  §11.10 SQLite migration retires the O(N) flush entirely.
  Metadata upgrades (label refresh, reachability flip, `_`→teamId) are **strictly
  write-on-change (compare-then-write)**: an already-current value schedules NO snapshot, so a
  healthy, unchanging conversation costs zero writes (scalability-G4). `reachability` also
  auto-clears to `ok` write-on-change (§5.1), so a re-invited channel does not thrash the store.
- `GET /conversations/health` carries `entryCount` (the resident-heap axis) + `fileSizeBytes`
  with a threshold attention item (design ceiling stated: ~50k entries / ~10MB is the
  JSON-store ceiling; **the threshold item fires at 80% of the ceiling — 40k entries / 8 MB —
  R3-minor, previously an unpinned fraction**). The snapshot-lost replay bound is `O(retained-journal-lines)`, and the
  journal's retained size is capped (§8 rotation) so replay is bounded even at the ceiling.
  Replication-emit volume is a scale axis too: per-entry emits COALESCE within the batched
  window — meaning ONE transport push carrying ALL records changed in the window, never a
  dropped/elided sibling record (R3-minor: "coalesce" is batching, not lossy dedup).
- **Named escape hatch (not deferred silently):** past the ceiling, migrate to
  snapshot + append-journal (the `conversation-registry.jsonl` WAL is already half
  of it — make the append-journal the PRIMARY) or SQLite (the pending-relay-store precedent;
  §11.10 / the Rejected-alternative subsection below). §11 tracks it as a planned migration,
  and it MUST land BEFORE the ceiling, not AT it (scalability-G2), so 100k entries is a
  scheduled move, never an incident.

**WAL crash-consistency contract (codex-R4-3 — a recovery-critical journal needs a real
contract, not "append a line").** The journal is the crash-durability write-ahead log; the
JSON snapshot is a rebuildable cache. The contract:
- **Journal path PIN (R2-integration-1 + R3-C4 — the entry must be a shape the DEPLOYED
  resolver actually expands).** Two constraints compose here. (1) The two-log-roots hazard
  (R2-integration-1): instar has BOTH `<agentHome>/.instar/` (the StateManager stateDir root)
  AND `<agentHome>/logs/` (the server.log/reap-log convention), and `BackupManager` resolves
  manifest entries stateDir-relative — so the journal MUST live under the stateDir. (2) The
  deployed glob resolver (R3-C4, code-grounded @ v1.3.722): `BackupManager.expandGlob`
  (`src/core/BackupManager.ts:97-112`) supports ONLY **top-level trailing-star** globs — for
  any pattern whose prefix or suffix contains `/` it returns the literal string
  (`if (prefix.includes('/') || suffix.includes('/') || suffix.includes('*')) return [entry]`),
  and `createSnapshot` (`:284-315`) then `existsSync`-checks that literal → false → the entry
  is SILENTLY SKIPPED. The round-3 pin `logs/conversation-registry.jsonl*` was therefore a
  DEAD manifest entry (the same class as the deployed `pr-pipeline.jsonl*` dead entry), and
  the WAL never entered a snapshot. **Resolution: the journal is RELOCATED to the stateDir
  ROOT — `<stateDir>/conversation-registry.jsonl`** (i.e. `.instar/conversation-registry.jsonl`,
  beside `shared-state.jsonl`) — **and the backup manifest entry is the top-level trailing-star
  glob `conversation-registry.jsonl*`**, byte-parallel to the ONE deployed working glob
  precedent (`shared-state.jsonl*`, `BackupManager.ts:84`), which captures the live file plus
  rotated `conversation-registry.jsonl.<epoch>` files with ZERO shared-code change. The
  alternative — extending `expandGlob` with subdirectory-aware expansion — was considered and
  REJECTED: it is a shared-code increment on the backup path every agent rides, for zero
  functional gain over relocation (Reuse over Re-implementation). Both constraints are now
  satisfied by the deployed code as-is. The §10 Tier-2 test asserts the glob's **EXPANDED set
  is non-empty and every expanded file is PRESENT IN the created snapshot** — never merely
  "the entry resolves via the stateDir-join" (a glob entry does not; the round-3 test wording
  was unfalsifiable as written). Every reference to the journal in this spec means this pinned
  path.
- **Record framing:** each journal line is ONE self-contained JSON object
  `{ seq, op: "mint"|"alias"|"reachability"|"bind-pin"|"bind-release"|"ambiguous-send"|
  "send-retire", key, tuple, id, origin, hlc, ts }` terminated by a newline (the last two ops
  carry `{ conversationId, logicalSendId }` in place of the registry fields — the R4-M2
  durable E1 dedup entries, §5.0(a)). **`seq` is a SINGLE GLOBAL monotonically-increasing
  counter — spanning rotated files AND process restarts (R3-M14; "per-file" is retracted: the
  recovery replay `seq > snapshotHighWaterSeq` and the pruning rule both require global
  comparability, and a per-file reset would skip or double-apply records).** At boot the
  counter resumes from `max(snapshotHighWaterSeq, highest seq across all retained journal
  files)` — never from 0/1. A reader tolerates
  a **torn tail** (a crash mid-append): the last line lacking a terminating newline OR failing
  JSON parse is DISCARDED (only a fully-written, newline-terminated line is a committed
  record). No line is ever rewritten in place (append-only), so an earlier record can never be
  corrupted by a later crash. §10 pins a replay test SPANNING a rotation boundary.
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
  snapshot). **Platform footnote (R3-minor):** on macOS, `fsync(2)` does not guarantee platter
  durability (the drive may cache); the "cheap append+fsync" cost claim assumes the cheap
  variant, and that is the DELIBERATE choice — `F_FULLFSYNC` is the named stronger option if
  disaster evidence ever demands it, and the §11.10 SQLite migration inherits SQLite's
  battle-tested handling of exactly this layer. Named residual, consistent with §3.7.
- **Snapshot high-water mark:** the batched JSON snapshot persists the highest `seq` it
  incorporated (`snapshotHighWaterSeq`). Recovery loads the snapshot, then replays ONLY journal
  records with `seq > snapshotHighWaterSeq` — so replay is bounded (never the whole journal) and
  the snapshot + tail compose to the exact pre-crash state. **Completeness corollary (made
  explicit with the R4-M2 ops): the snapshot must therefore persist ALL journal-applied store
  state — the conversations/aliases maps, LIVE bind-pins, and UNRETIRED `ambiguous-send`
  entries — because the rotation rule below prunes journal files every record of which is
  `≤` a persisted snapshot's high-water; a pin or dedup entry the snapshot omitted would be
  silently lost at exactly that prune.** §10's replay tests assert the composition for all
  three state kinds.
- **Idempotent replay:** replay applies records in **`seq` order** (globally comparable —
  above); re-applying a record already present (from the snapshot or an earlier replay) is a
  no-op, and this holds explicitly for `op:"alias"` re-points and `op:"bind-pin"`/
  `"bind-release"` transitions too (each is a state-idempotent set/clear whose effect under
  seq-ordered re-application is identical — R3-minor). Replay is therefore safe to run any
  number of times, and a crash DURING replay simply re-runs it.
- **Rotation/checkpoint:** the journal rotates by size OR line cap — pinned defaults
  `journalRotateBytes = 8388608` (8 MB) / `journalRotateLines = 50000` (R3-minor, previously
  unpinned) — with retention pinned at **rotated files covering ≥2 full backup cycles, minimum
  7 days** (the §8 floor is a recovery requirement: §6.2 journal replay must always be
  available between backups); `seq` CONTINUES across rotation (never resets — M14); a
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
BOTH: `state/conversation-registry.json` (a literal subdirectory FILE path, which the deployed
`createSnapshot` handles — only GLOBS are top-level-constrained) AND the top-level journal GLOB
`conversation-registry.jsonl*` (the §journal-path pin at the stateDir ROOT — the shape the
deployed `expandGlob` actually expands, R3-C4; it captures the live file plus rotations within
retention) in `config.backup.includeFiles`.

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
entries AND — through the REAL deployed `BackupManager` — that after a durable mint the glob's
**expanded file set is non-empty and every expanded file lands in the created snapshot** (the
literal snapshot-file entry asserted present in the snapshot the same way; a string-only /
dead manifest entry fails the test — R3-C4). **Backup restore is the PRIMARY disaster-recovery
path** (gemini-G2); journal replay (§6.2) is the secondary; deterministic re-mint is the last
resort with the documented probe-order risk.

### 3.5 Multi-machine replication semantics — a BESPOKE store, not a standard consumer

**Posture declaration (Cross-Machine Coherence — mandatory).** The registry is
**machine-local at the mint site** (the owning/serving machine mints) and **replicated as
a dark, dev-gated store** (`multiMachine.stateSync.conversations`, §9). Delivery
resolution is **owning-machine-authoritative** (§5). A single-machine agent is a strict
no-op.

**Authority scoping — R governs registry SHAPE; delivery authority is LOCAL (the R3-C1/C2/C3
root, stated once, plainly).** The merge MUST be a pure function of the ingest-accepted record
set `R` for convergence — so `R`, populated by peers whose local lifecycles are not globally
ordered, IS authoritative for **id-assignment and registry shape**. The oft-repeated claim
"replicated is advisory, never authority" is therefore SCOPED: it holds for **delivery** (the
local-origin gate, the owning-machine predicate, the §3.5.2 bind-pin overlay — all local,
none merge inputs) and for **principal/workspace identity** (§3.1), but NOT for registry
shape, where accepting a peer's record inherently lets it perturb canonical assignment. No
local-lifecycle datum (a binding opening or closing, a reachability observation, an operator
action) may EVER be a merge input — that is the constitution's Convergent Merge Algebra
standard, and it is why the round-3 `sticky` marker is removed rather than repaired.

**Back-dating threat honesty (R3-M6 — the `≺` inversion, mirroring the §3.3 birthday-honesty
pattern).** The algebra is lowest-HLC-wins, which inverts the forgery threat: the profitable
forgery is a LOW `hlc.physical`, and the ingest is deliberately EXEMPT from the pool-relative
skew quarantine (equal-R, §3.5.1), so the only bound on HLC plausibility is the FIXED absolute
window — which must be wide (it admits years-old records from an offline-returning machine).
**Consequence, stated rather than implied: a compromised peer CAN back-date within the window
and win canonical assignment in any collision/same-tuple merge it targets — registry shape is
peer-perturbable by design.** What bounds the blast radius is the authority scoping above:
delivery never follows a replicated-only entry (local-origin gate), a live durable binding's
delivery is bind-pin-protected (§3.5.2), and the id↔key coherence + seize-refusal + class-cap
(below) bound HOW MUCH shape a forged record can perturb — so the residual harm is
registry/alias churn + attention noise, never message misdelivery. Two tripwires make the
churn loud: the per-origin displacement anomaly counter (an origin whose records force
`> displacementAnomalyPerWindow = 8` displacements per 10-min window raises ONE deduped
attention item naming the origin) and the ingest-refusal aggregation (below). B4 still pins
the tiebreak fields (`mintedBy`/`hlc.node`) to the authenticated envelope origin — the
UNPINNABLE field is `hlc.physical`, and this paragraph is the spec's honest accounting of it.

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
  `physical` falls outside a **FIXED ABSOLUTE sanity window** is **quarantined-aside on
  ingest**, not applied. **The window constants are PINNED, frozen, schema-v1 (R3-M10 — these
  were the last unpinned frozen-forever values, and `physical`'s unit/epoch was silently
  assumed): `physical` is MILLISECONDS since the Unix epoch (§3.4);
  `HLC_ABS_MIN = 1767225600000` (2026-01-01T00:00:00Z — no legitimate conversation record
  predates the feature) and `HLC_ABS_MAX = 4102444800000` (2100-01-01T00:00:00Z). Identical
  on every machine and every version; changed ONLY by a versioned migration (the same
  treatment as `MAX_PROBE_DISTANCE`/probe direction — a mixed fleet comparing different units
  or windows would pick divergent winners). The `HLC_ABS_MAX` horizon year is 2100 — a
  documented time-bomb requiring a versioned re-pin migration WELL before the horizon
  (R3-minor); all three constants (unit, MIN, MAX) join the §10 golden-parity suite.** So a forged
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
  absent from the allowlist); any `sticky`/binding-marker field arriving on the wire is
  **STRIPPED on ingest** (R3-C1/C2/C3 — durable-binding protection is local-only, §3.5.2; a
  peer cannot inject binding state);
  timestamps ISO-8601-only; `hlc.physical` is **NOT clamped in value** — instead it is
  **accepted-or-quarantined against a FIXED ABSOLUTE sanity window** (`HLC_ABS_MIN =
  1767225600000` … `HLC_ABS_MAX = 4102444800000`, the pinned schema-v1 constants — R3-M10,
  identical on every machine), so a forged `{physical:0}` is quarantined on
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
- **Collision-class stuffing cap (R3-M7 — manufactured collisions are constructible, so the
  class size must be adversary-bounded).** The candidate is a non-cryptographic 32-bit hash and
  `channelId` is only shape-clamped, so a compromised peer can CONSTRUCT tuples colliding at a
  victim's candidate and fill the class's taken-offsets walk (≤64 fabricated tuples would force
  the victim's legitimate local mint into the §3.6 pending-mint degradation — a targeted DoS
  the §3.3 birthday table, which models only ACCIDENTAL collisions, does not cover). Therefore
  ingest acceptance caps **UNCORROBORATED replicated-origin records per collision class** at
  `uncorroboratedClassCap = 16`: each class retains the `≺`-least 16 uncorroborated records in
  `R`; further uncorroborated claimants of the same class are quarantined-aside (+ the
  aggregated refusal item, below). The retained set is a pure function of the RECEIVED set
  (deterministic `≺`-least selection, re-evaluated as records arrive; an evicted record leaves
  `R` deterministically on every machine) — so convergence is preserved. Local-origin and
  locally-corroborated records are NEVER capped (a legitimate local mint always enters its
  class), and `16 + genuine collisions ≪ MAX_PROBE_DISTANCE = 64`, so the displacement walk
  stays bounded away from the pending-mint cliff. §10 pins the stuffing test.
- **Ingest-refusal attention is EMITTER-AGGREGATED (R3-M12 — the §5.1 aggregation pattern,
  applied to the ingest boundary).** Every ingest refusal class — seize-refusal, id↔key
  coherence quarantine, alias episode, workspace-pin conflict, HLC-absolute-window quarantine,
  class-cap quarantine — routes through ONE aggregating emitter with the pinned 60 s
  coalescing window and per-origin dedup: N malformed/hostile records from one origin in a
  window produce **ONE summary attention item** (origin + per-class counts + a bounded sample
  of keys), never N items. The per-episode "ONE deduped attention item" wording throughout
  §3.1/§3.5/§3.6 is hereby scoped THROUGH this aggregator — a compromised peer replaying
  distinct malformed records cannot reconstruct the 2026-05-22/06-05 topic-flood shape on the
  ingest boundary. §10 pins the burst test (N distinct refusals → one aggregated item).
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
  - **Atomic, idempotent winner-flip (A5) — UNCONDITIONAL in the merge (R3-C1/C2/C3: the
    round-3 "never against a STICKY id" carve-out is REMOVED).** A genuinely-lower-HLC record
    can arrive LATE and demote a settled winner, and the merge applies that demotion from `R`
    alone — no local binding state is consulted (a live durable binding never blocks the flip;
    its DELIVERY is protected by the §3.5.2 bind-pin overlay, which never touches assignment).
    The re-point
    is a SINGLE atomic, idempotent-under-replay transaction, journaled as ONE `alias` op: within
    the store's serialized `mutate()`, (1) record `loserId → newWinnerId`, and (2) **re-scan the
    alias table for every alias whose target === the demoted id and re-point it to the new
    winner in the same op** — so aliases never form a chain and a mid-replay crash re-runs to the
    same state. `resolve()` therefore always returns the current winner in one hop, even across a
    winner-flip. **Journal-amplification bound (R3-minor):** each flip journals O(k) re-points
    (k = aliases targeting the demoted id); a worst-case-ordered deep collision class costs
    O(k²) total re-point lines across its heal — bounded by k ≤ `MAX_PROBE_DISTANCE = 64`
    (≤ ~4,096 lines per class, once, at heal time; §10 asserts the bound). §10 pins: three ids
    for one tuple arriving in every permutation converge to a
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
  ensure that can never orphan a locally-bound id, every entry this machine ADOPTS is copied
  into the LOCAL origin namespace as `adopted-replicated`. **The adoption trigger has exactly
  ONE definition (R3-minor — two wordings previously coexisted): the FIRST AUTHENTICATED
  INBOUND on that tuple (a local mint-hit at the §6.3 dispatch). A delivery-time `resolve()`
  NEVER confers local origin — otherwise a non-owning machine could self-promote an entry to
  deliverable merely by attempting delivery, breaking the KYP/one-voice invariant.**
  Un-merging a peer then cannot remove an id this
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
  **Null-`threadTs` ordering is PINNED (R3-minor — the byte-form tiebreak must be total):**
  the compared byte-form is `platform + '\x1f' + channelId + '\x1f' + (threadTs ?? '')` (the
  §3.4 tupleKey), so a null `threadTs` compares as the EMPTY string and sorts BEFORE any
  concrete `threadTs` — the channel-level tuple deterministically precedes its own threads on
  every machine.
- **There is NO binding/lifecycle input (R3-C1/C2/C3 — the round-3 `sticky(t)` predicate is
  REMOVED from the algebra).** `sticky(t)` read "R carries a durable-binding marker for tuple
  `t`'s ASSIGNED id" — but the assigned id is what the merge COMPUTES, so the marker was
  written against an arrival-order-dependent provisional id (C1: two machines could bind the
  "same" marker to different ids and never agree again); its expiry contradicted replication
  monotonicity (C2: the owner's clear is refused by every peer that ingested `true` →
  permanent divergence; never-clearing instead leaks until every id is sticky and `≺` is
  dead); and the two-sided partition case had no consistent resolution at all (C3).
  Durable-binding protection now lives entirely OUTSIDE the merge, in the local, NEVER-
  replicated §3.5.2 bind-pin overlay. Every input above is carried by the records of `R`
  themselves — nothing else exists for the merge to read, which is what makes the fixpoint
  unique (below).

**Assignment (the pure resolution of `R` to one id per tuple):**
1. **Canonical reservation (A3) — by `≺` alone (R3-C1: the round-3 sticky-canonical override
   is REMOVED; ownership is decided from `R`, never from whose binding is live where).** Each
   id `cand(t)` is RESERVED for tuple `t` and for `t` alone. Where several distinct tuples
   share the same `cand` (a genuine collision), the `≺`-least claimant owns the canonical id;
   the rest are *displaced*. A displaced tuple that carries a live LOCAL durable binding on
   this machine loses nothing at delivery time: its binding's delivery follows the tuple to
   its post-merge assignment through the §3.5.2 bind-pin overlay (the consumer's stored
   `topicId` is NEVER mutated — the §2 decision-1 constraint), with ONE deduped attention
   item when a pin actually redirects — never a silent strand.
2. **Displaced-tuple resolution (A1/A4 — key-derived, never occupancy-order; GLOBAL per
   R4-C1).** ALL displaced tuples in `R` — across ALL collision classes — are processed in
   ONE GLOBAL `≺` order against ONE GLOBAL taken set, initialized to the step-1 reserved
   canonicals. Each displaced tuple, in that order, walks its FROZEN down-sequence `cand(t),
   cand(t)-1, cand(t)-2, …` and takes the first offset NOT in the taken set, then ADDS its
   assignment to the set. This is a pure function of the tuple set — no live occupancy, no
   arrival order — so both machines assign the same offset. **The occupancy check is
   deliberately NOT per-collision-class (R4-C1 — the round-3 per-class reading let two
   displaced tuples from ADJACENT classes take the SAME id: class A's T2 displaced from `C`
   lands on `C−2`, class B's U2 displaced from `C−1` also lands on `C−2` because each class's
   own set was empty — a convergent-but-wrong duplicate assignment violating step 3's
   invariant, constructible with 3 crafted records under the M7 threat model. One global set
   makes "no id resolves to more than one tuple" hold BY CONSTRUCTION across classes: an
   offset enters the taken set exactly once.)** **The §3.3 local mint applies this SAME rule —
   one shared implementation, §10-pinned (R2-adversarial-2).** A walk exceeding
   `MAX_PROBE_DISTANCE` is the §3.6 pending-mint degradation, identical on both machines.
3. **Winner id per tuple** = the id from step 1 or 2. Any OTHER id present in `R` for that same
   tuple (a machine's provisional local mint that disagreed — §3.3) becomes a **one-hop alias →
   winner id** (the atomic winner-flip, §3.5 — unconditional; a demoted id that carries a live
   local durable binding keeps DELIVERING correctly through the §3.5.2 overlay, which the
   merge never reads). No id resolves to more than one tuple; no tuple resolves to more than
   one winner.

**Sub-step composition order is PINNED and the fixpoint is UNIQUE (R3-C1 — the round-3 text
left the composition of same-tuple resolution vs sticky reservation unordered, so two
machines could apply the rules in different orders and settle on different owners).** The
three steps above are evaluated in that FIXED order — canonical reservation (per class), then
ONE GLOBAL displacement pass in global `≺` order (R4-C1 — never per-class), then same-tuple
alias derivation — and every predicate they read (`cand`, `≺`, the claimant sets, the global
taken set) is a pure function of `R`. With the sticky rule
removed there is no second rule system left to compose against: for a given `R` the
assignment has exactly ONE fixpoint, reached in one ordered pass. **The
restored invariant, stated plainly: `assign : R → (tuple → id)` is a total deterministic
function of the ingest-accepted record set alone — no local binding state, no arrival order,
no wall clock, no machine identity beyond what records themselves carry — so two machines
holding equal `R` CANNOT disagree, permanently or transiently, on any assignment.** §10's
fuzz suite (≥3 machines, permuted arrival, run WITH live local bind-pins present on colliding
ids) asserts byte-identical `resolve()` on every machine AND that the presence or absence of
any bind-pin never changes a single assignment.

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

**Complexity bound — the pure function specifies the RESULT, never the execution strategy
(R3-M3, restated as a BOUNDED CASCADE per R4-C1).** "Pure function of `R`" does NOT license a
naive full recompute per ingested record — that is O(N²) across an initial replication sync
or an offline machine's bulk catch-up, on the SHARED event loop: the CommitmentTracker
2026-06-21 freeze shape relocated to the ingest path, biting exactly when increment 9 soaks.
Application MUST be incremental — but the round-3 premise "an ingested record touches exactly
ONE collision class" is RETRACTED (R4-C1: it assumed class independence, which fails exactly
when displacement walks overlap — a re-resolved class can change the occupancy of offsets
that a NEIGHBOR class's displaced tuples, within `MAX_PROBE_DISTANCE`, depend on). The
incremental strategy is a **deterministic bounded cascade**: seed a worklist with the
ingested record's own collision class (O(1) via the §3.4 cand→claimants multimap); on
re-resolving, for every offset `o` whose occupancy CHANGED, enqueue every class with
a claimant `cand ∈ [o, o + MAX_PROBE_DISTANCE]` (the only classes whose walks can reach `o` —
probes go DOWN, so influence propagates only within a 64-wide window; located by the ordered
range query, §3.4 index 5). **Termination is BY CONSTRUCTION, not by iteration-to-fixpoint:
each drain step widens the affected REGION (a set of classes, grow-only within one drain) and
re-executes the §3.5.1 step-2 pass RESTRICTED to that region — all displaced tuples whose
`cand` lies in the region, in global `≺` order, against a taken set rebuilt for the region
(reserved canonicals + displaced assignments of classes OUTSIDE the region are read as fixed
occupancy) — a fresh restricted evaluation of the pure function, never a per-class chaotic
relaxation that could oscillate. The drain ends when a restricted pass changes no occupancy
outside the region already enqueued; since the region only grows and is bounded by the
classes in `R`, it terminates, and the restricted pass equals the full pure function on the
region by locality (no walk crosses a >64 gap).** The cascade REGION is the transitive
overlap-closure of the touched class:
in the accidental regime it is almost always one class (adjacent genuine collisions within 64
ids of each other are negligible per the §3.3 birthday math); adversarially, an attacker
chaining classes 64 apart pays ≥1 crafted record per 64-id window (each class-capped at 16
uncorroborated), so total cascade work stays LINEAR in the records the attacker ships —
amortized O(1) per ingested record, never O(|R|). §10 asserts BOTH: byte-equivalence of the
incremental cascade to a from-scratch full recompute over the same `R` (including
adjacent-class shapes), and per-record ingest cost independent of `|R|` against a large
seeded `R`. Bulk arrival batches: the classes touched in a batch are collected and the
cascade is drained ONCE at the batch end, never once per record.

**"Same `R` on every machine" is DELIVERED by the transport, not assumed
(R2-adversarial-3).** The bespoke store rides the journal transport whose generic `receive()`
skew check is RECEIVER-relative (pool-relative reference clock) — an online machine and an
offline-then-returning machine could quarantine DIFFERENTLY, silently breaking the equal-`R`
premise (permanently, if the ingest cursor skips a quarantined record). Therefore the
conversations store's ingest is **EXEMPT from the foundation's pool-relative skew
quarantine**: its OWN machine-independent anti-forgery gate is the §3.5 FIXED ABSOLUTE HLC
sanity window (identical constants on every machine), which is the acceptance check that
matters for convergence.

**Quarantine-retry discipline (R3-M13 — the round-3 "retried, never cursor-skipped" rule
shipped with no backoff, no cap, and no terminal path: a genuinely-broken-clock peer would
park the per-origin ingest cursor FOREVER, head-of-line-blocking every later record from that
origin — the #867 compounding-spiral shape).** The rule also conflated two quarantine reasons
that demand OPPOSITE treatments; they are split:
- **Absolute-HLC-window quarantine is TERMINAL.** It is a pure function of the record's own
  content, identical on every machine, so no retry can ever change the verdict. The record is
  dropped to the quarantine ring (auditable), the cursor ADVANCES, and `R` deterministically
  excludes it EVERYWHERE — no liveness risk and no divergence (every machine drops the same
  record).
- **Pool-relative transport quarantine is RETRYABLE — with P19 brakes.** The held record
  moves to a per-origin SIDE-QUEUE (the cursor advances past it, so the origin's later
  records ingest normally while it waits), retried with exponential backoff (base 60 s, ×2
  per attempt, capped at 1 h) up to `quarantineRetryMax = 20` attempts (≈24 h). **The
  side-queue's CARDINALITY is bounded (R4-minor-2 — per-record retries were bounded but the
  record COUNT was not; a peer streaming pool-relative-quarantined records would grow the
  queue without limit for ~24 h): `quarantineSideQueueMax = 256` held records per origin;
  a record arriving past the cap skips the retry ladder and parks-aside IMMEDIATELY (the same
  loud terminal as exhaustion, counted in the aggregated refusal item) — never an unbounded
  in-memory queue (Bounded Blast Radius, the memory axis).** Exhaustion is
  LOUD, never silent: the record is parked-aside + ONE deduped attention item stating the
  honest condition — the machines genuinely hold unequal `R` for that record and are
  non-convergent on it until the origin re-emits or the operator intervenes. A broken-clock
  peer therefore costs a bounded side-queue and one attention item — never a wedged origin
  cursor.

§10 pins: a returning machine with a stale pool reference ingests the same record set and
reaches byte-identical `resolve()`; PLUS the sustained-failure shape — a permanently-held
record does NOT block later records from its origin, and its retry exhaustion produces
exactly ONE parked-aside + attention item (never a wedge, never silence).

The seize-refusal (§3.5) is the ONLY non-merge outcome: it fires exactly when a record's claimed
`id` is unreachable under steps 1–2 for its own tuple (neither its `cand` nor a within-bound
collision-probe offset) — i.e. a genuine hijack/corruption — and such a record is quarantined out
of `R` entirely, so it can never perturb the pure resolution above.

### 3.5.2 The bind-pin overlay — durable-binding protection OUTSIDE the merge (R3-C1/C2/C3/M8)

The round-3 `sticky` marker tried to protect a durably-bound id INSIDE the merge and broke
the algebra three ways (C1 provisional-id divergence, C2 monotonic-vs-expiry
self-contradiction, C3 the unreconcilable two-sided partition). The protection it was after
is real — a beacon must keep landing in the thread its commitment was opened in, across any
merge outcome — so it is rebuilt here as a LOCAL, DELIVERY-TIME overlay with five hard
properties:

1. **Never a merge input, never on the REGISTRY wire.** A bind-pin is machine-local state:
   not a field on the registry entry, not in the registry replication record (an inbound
   `sticky`/binding field is STRIPPED at the §3.5 clamp), and §3.5.1 never reads it. The
   merge stays a pure function of `R` by construction — restoring the correctness argument
   the sticky marker invalidated. (Precision, so property 5 is not read as a contradiction:
   the record-carried `boundTuple` travels the COMMITMENTS wire on the binding record — never
   the registry's — and is consumed exclusively at delivery time; the registry merge has no
   path that reads commitment records, so nothing binding-derived can reach `R` on any wire.)
2. **The pin binds an id to a TUPLE, not to an assignment.** When a durable consumer binds to
   a minted id (a commitment opens, a working-set carry attaches — the §3.3 `durableBinding`
   paths), the binding machine records `bind-pin { boundId, tuple, refcount }` — the tuple
   the id resolved to AT BIND TIME. The consumer's stored `topicId` stays VERBATIM forever
   (the §2 decision-1 constraint: 168 files hold it as a number and CANNOT rebind). Nothing
   ever mutates a commitment's `topicId` — the exact mutation C3 proved inconsistent.
3. **Delivery follows the TUPLE through the merge.** `deliverToConversation(id)` on the pin
   holder consults the overlay FIRST: if `id` carries a live bind-pin, the delivery target is
   the pin's tuple at its CURRENT §3.5.1 assignment — `resolve(pin.tuple)`, not
   `resolve(id)`. While merge and bind agree (the overwhelmingly normal case) the two are
   identical and the pin is invisible. When a late merge demotes or re-assigns the bound id,
   the bound consumer's messages still land in the conversation the promise was made in —
   while every OTHER read of `resolve(id)` returns the merge's answer (registry shape is
   never forked). The first time a pin actually REDIRECTS (bound id ≠ the pin-tuple's current
   assignment), ONE deduped attention item names the episode (per pin, not per message) —
   visible, never silent, never a strand.
4. **Refcounted, journaled, crash-safe (R3-M8 — a single boolean cleared on "the" binding
   close strands a still-live sibling binding; and C2's expiry problem dissolves).** The pin
   carries a live-binding REFCOUNT: each durable bind increments (`op:"bind-pin"` journal
   line, §3.4 — fsynced with the bind's own WAL line), each binding close decrements
   (`op:"bind-release"`), and the pin is released only at ZERO — a commitment closing never
   strands a still-live working-set carry on the same id. Because the pin is never
   replicated, its lifecycle is purely local-authoritative and there is nothing to converge:
   C2's set-vs-clear partition contradiction cannot arise for it. Boot replay (§3.4 `seq`
   order) restores live pins exactly.
5. **The bind-time tuple ALSO rides the durable binding record itself — so the pin is
   RECONSTRUCTIBLE on any machine that ever delivers the binding (R4-M1).** The journaled
   machine-local pin above protects delivery on the machine that BOUND — but §5's stand-down/
   pickup path is a DESIGNED second deliverer: with increment 9 live, `CommitmentsSync`
   replicates a commitment to a machine that never bound it, and that machine's beacon picks
   the delivery up on becoming the owner. Without the pin it would deliver via bare
   `resolve(id)` — reopening the exact C3-class misdelivery on the ownership-migration path.
   Therefore every durable bind DENORMALIZES the bind-time tuple onto the binding record as
   `boundTuple` (a new optional field on the commitment / working-set record, written at bind
   time by the same §3.3 WAL-fsynced open; the deployed `Commitment` shape already grows
   per-feature optional fields — `CommitmentTracker.ts:59+`). Delivery-time rule, UNIFORM on
   every machine: a durable binding's delivery target is `resolve(binding.boundTuple)` when
   `boundTuple` is present — the local journaled pin and the record-carried `boundTuple`
   yield the SAME tuple by construction (recorded at the same bind moment); a legacy binding
   with neither falls back to `resolve(id)` (today's behavior). The reconstruction is
   delivery-time-only and NEVER a merge input (the merge never reads commitment records).
   **Trust posture, stated honestly:** `boundTuple` arrives on a REPLICATED record, so it is
   shape-clamped at the `CommitmentsSync` receive clamp (the `clampReplicatedRow` chokepoint,
   `CommitmentsSync.ts:149-155` — platform enum, channelId/threadTs shape regexes, exactly
   the §3.5 tuple clamps) — and it grants NO authority `topicId` does not already grant: a
   forged replicated commitment could already point its `topicId` anywhere, and delivery
   still requires the delivering machine to pass §5.0 `ownsConversation` + the local-origin
   resolution of the TARGET. The field narrows misdelivery; it cannot widen it.

**The C3 two-sided partition, walked through the overlay (the case the sticky design could
not reconcile).** T1, T2 collide at `C`; during a partition machine A opens a commitment on
T1 (pin `C→T1` on A), machine B opens one on T2 (pin `C→T2` on B). Heal: both machines' merges
over the same `R` agree — say `≺`-least T1 owns `C`, T2 displaces to `C-1`. Registry shape is
byte-identical on A and B (the pins were never inputs). A's pin (`C→T1`): T1 still holds `C` —
no redirect, delivery unchanged. B's pin (`C→T2`): T2 now sits at `C-1` — B's beacon delivers
through the pin into T2's real thread; its commitment record still reads `topicId = C`,
untouched. No id serves two conversations, no binding is stranded, no commitment is mutated,
and no machine disagrees on `resolve(C)`. **Locality, stated honestly (corrected per R4-M1 —
the round-4 wording claimed "only that machine's beacon fires for it," which §5's own
stand-down/pickup path contradicts):** the JOURNALED pin lives only on the machine that
bound; a DIFFERENT machine that later becomes the deliverer (ownership adoption, §5)
reconstructs the same protection from the binding record's `boundTuple` (property 5) — so
the protection follows the binding wherever `CommitmentsSync` carries it, while the overlay
itself stays delivery-time-only and off the wire as merge input. **Degradation:** if a pin's tuple is itself in the §3.6 pending-mint
state (no current assignment), delivery returns the §5.1 typed non-delivery + one deduped
attention item — the beacon retries; never a misdeliver, never a silent drop.

§10 pins the overlay suite: merge-blindness (assignments byte-identical with and without live
pins — the fuzz suite runs WITH pins present); redirect correctness (the C3 walk above, both
machines); refcount semantics (two binds, one close → pin holds; last close → released);
restart replay restores live pins; a wire-arriving `sticky`/binding field is stripped on
ingest; a redirect raises exactly ONE deduped attention item per episode; **and the
ownership-migration pickup (R4-M1): commitment bound on machine A (boundTuple recorded),
replicated to B, B becomes the owner (first authenticated inbound adoption), the merge
demotes the bound id → B's beacon delivers into the bound tuple's REAL thread via
`resolve(boundTuple)`, never bare `resolve(id)`; a forged/malformed replicated `boundTuple`
is shape-clamp-rejected at the CommitmentsSync receive and the binding falls back to
`resolve(id)` (never a crash, never an unclamped tuple applied).**

### 3.6 Failure modes (decided)

| Failure | Behavior |
|---|---|
| Registry unavailable/corrupt at inbound time | **Fail toward delivery**: compute `candidate(routingKey)` in-memory — byte-identical to today's legacy behavior — proceed, and journal a pending-mint (keyed/deduped by canonical key: ONE pending-mint per conversation, not per message; bounded at `pendingMintMax = 1000` (R3-minor, previously unpinned) with a loud drop counter). **Collision-blindness guard (B6):** whenever the in-memory reverse index is still readable (breaker-drop, slow/contended registry), consult it BEFORE using the raw candidate — a candidate occupied by a DIFFERENT tuple resolves via the §3.5.1 probe for the READ, never a cross-conversation misdeliver; only a fully-lost index (nothing to consult) falls back to the bare candidate as the last-resort floor. Corrupt file → quarantine-aside + rebuild (§6.2). |
| Registry present but SLOW/contended | The id is assigned SYNCHRONOUSLY in-memory (probe included) so returned==persisted; only the durable write is deferred; mutate-queue overflow degrades to the pending-mint path (never a blocked inbound). |
| Registry UNAVAILABLE, a binding was made against the raw candidate, then registry recovers and the candidate is occupied by a different tuple | Heal FORWARD via the §3.5.2 overlay (uniform mechanism — R3-C3 consistency): recovery records a bind-pin `{ boundId: rawCandidate, tuple: the binding's tuple }`, so the binding's delivery follows ITS tuple to the newly-assigned (probed) id — the binding's stored id is NEVER mutated, and never aliased onto the live foreign id (§3.5 refuses same-id/different-tuple; the raw candidate is only ever exposed on the registry-unavailable path, and only that path's bindings need forward repair). The heal is journaled + one deduped attention item. |
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
probed/thread-level ids.

**The projection alternative, compared concretely (codex-R3-#3 — the round-3 justification
rested on the coupling argument alone).** The serious middle option is "SQLite as the LOCAL
source of truth, emitting JSON change records as a replication PROJECTION." It is rejected
for Phase 1 on a durability-contract argument, not house style: the replication substrate
reads per-origin JSON FILES as its durable source (snapshot-then-tail over files on disk), so
a projection is a SECOND durability contract — every SQLite commit must also durably land its
JSON projection, and a crash BETWEEN the two silently forks replication truth from local
truth (exactly the divergence-without-a-detector class this spec exists to close; closing it
would need its own WAL-grade dual-write protocol, i.e. the complexity we were trying to
shed, now spent on glue instead of storage). Keeping ONE durable representation (JSON + WAL)
that IS the replication source removes the dual-write seam entirely. At the §11.10 migration
the calculus flips: SQLite becomes the source AND the emitter is rebuilt against it as one
increment — which is why that migration is tracked as a real project, never a config flip.

**Verification residual, stated honestly (R2-lessons-5):** WAL
crash-consistency is only partially verifiable by SIGKILL-style tests — a kill lands at a
process boundary, while the real hazards (power loss mid-fsync, filesystem reordering) are
below it; the §10 torn-tail/replay tests cover the reachable failure shapes and the rest is a
NAMED residual risk. This residual is an additional reason the §11.10 SQLite migration (whose
WAL is battle-tested at exactly these layers) should land SOONER on the evidence tripwire,
not merely at the size ceiling — **and the tripwire is BROADENED (gemini-R3-#2, endorsed):
ANY observed durability incident (a torn journal that loses a committed record, a replay
divergence, a backup-restore gap) triggers the §11.10 migration evaluation IMMEDIATELY, not
just the entry-count ceiling.**

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
            substitution value is REJECTED by its field schema, never rendered). **The
            exemption's SCOPE is pinned (R3-minor — the early return must not skip more than
            it names): the `deterministicKind` arm skips ONLY the tone gate — it still rides
            the §5.2 per-conversation + global budgets and the E1 guard; and no substitution
            field is EVER sourced from a replicated/peer-controlled field (`label` included —
            cross-ref B3): substitutions carry only locally-derived identifiers.** This mirrors the Telegram G1 design so the "always reachable" floor on Slack
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
logical-send-identity)` retirement-scoped dedup (R3-M1 — not a fixed window)** applied AT the
funnel: a repeat send of the same
logical send to the same conversation, while that logical send is still unretired, is
suppressed (returns a distinct
`already-delivered-recently` typed result the beacon treats as delivered, so it does NOT
re-escalate). Four load-bearing refinements (R3-M1/M2 superseding R2-lessons-1 a/b;
R2-security-NEW-3, R2-security-NEW-4):
- **Suppression is RETIREMENT-based, never a fixed window racing the real cadence (R3-M1 —
  supersedes the round-3 30-minute window derivation, which did not match the deployed
  beacon).** The real re-fire interval is NOT "the 20-min base": `atRisk` DOUBLES the cadence
  (`PromiseBeacon.ts:562-564` — 40 min already exceeds a 30-min window) and `maxCadenceMs`
  caps at 21,600,000 ms = **6 hours** (`:421-422`) — so an ambiguous re-fire can legally land
  hours outside any sane fixed window, and a literal `window ≥ max re-fire` startup assertion
  would clamp every install's window past 6 h. The guard therefore does not race the cadence
  at all: **a dedup entry for a `logicalSendId` persists until that logical send is RETIRED**
  — a delivered outcome advances the send sequence (below), or the commitment closes — with a
  hard TTL backstop of `ambiguousDedupTtlMs = 604800000` (7 days; safety bound only, never
  the suppression mechanism). The R3-M15 "margin" term is superseded along with the window
  derivation. An ambiguous re-fire of the SAME logical send is suppressed WHENEVER it arrives
  — 40 minutes or 6 hours later; the next logical send (new seq) never matches. §10 runs the
  idempotency test at the 6-hour backed-off cadence, never a sub-window fast retry.
- **The dedup entry is DURABLE — it rides the §3.4 journal, because a retirement-scoped entry
  is long-lived BY DESIGN and instar restarts on every auto-update (R4-M2 — the round-4 text
  parked it in an in-memory bounded map, which a restart or cap eviction wipes: ambiguous
  outcome → entry recorded → server restarts inside the 40 min–6 h re-fire gap → empty map →
  the re-fire of the SAME `logicalSendId` passes the guard → the exact double-post E1 exists
  to prevent. Note R3-M2's durable `sendSeq` makes the restart case WORSE alone: it correctly
  re-fires the same logical send, and only this guard was supposed to suppress it).** The
  mechanism: an ambiguous/likely-posted outcome appends `op:"ambiguous-send"
  { conversationId, logicalSendId, recordedAt }` to the §3.4 journal (fsynced — it is
  precisely a durable-binding-class write: not re-derivable after a crash); retirement
  appends `op:"send-retire"`. The two ops join the §3.4 record-framing enum, replay
  idempotently in `seq` order like `bind-pin`/`bind-release`, and boot replay restores every
  UNRETIRED entry — so the guard's answer is identical before and after a restart. The
  journal's pinned retention floor (≥7 days, §3.4 rotation) equals the entry TTL by
  construction, so rotation can never prune a live entry. The in-memory map becomes a CACHE
  of this durable state, rebuilt at boot.
- **An UNRETIRED entry is NEVER evicted below its TTL (R4-M2, the second arm).** The §5.2
  bounded/evicting structure applies to RETIRED/TTL-expired entries only. If the hard cap is
  reached with every entry still live (pathological — it means thousands of simultaneously
  ambiguous unretired sends), the guard sheds LOUDLY: ONE aggregated attention item naming
  the shed count, never a silent eviction that re-opens the double-post. §10 pins both
  directions: the restart-double-post test (ambiguous → restart → re-fire at the backed-off
  cadence → still ONE post) alongside the existing false-suppression direction (post-restart
  NEW heartbeat is NOT suppressed).
- **The guard keys on a STABLE logical send identity, not the raw content-hash
  (R2-lessons-1b), and the send sequence is DURABLE + MONOTONIC (R3-M2 — the deployed beacon
  has no send-seq concept, and a naive one breaks the guard in BOTH directions).** A beacon
  heartbeat interpolates elapsed/liveness text ("…23m elapsed"), so a retry's bytes differ
  and a content-hash never matches. The dedup key is `(conversationId, logicalSendId)` where
  `logicalSendId` = **`commitmentId + sendSeq`** for beacon sends (the beacon passes it via
  `opts`), falling back to the content-hash ONLY for callers with no logical identity.
  `sendSeq` semantics are pinned: **persisted in the beacon's per-commitment hot state —
  never in-memory-only — via an ATOMIC write (tmp→rename, the house pattern at
  `StateManager.ts:521-530`; R4-minor-1: the round-4 "journaled with it" wording is RETRACTED
  as overstating the deployed medium — `PromiseBeacon.saveHotState` is a plain non-atomic
  `fs.writeFileSync` (`PromiseBeacon.ts:1408-1411`), and a crash mid-write could corrupt the
  file and reset the seq, which would re-collide a reset seq against the now-DURABLE R4-M2
  dedup entry and silently suppress a legitimate post-restart heartbeat; the seq-bearing file
  therefore moves to the atomic pattern as part of the proof-consumer increment) — advanced
  ONLY on a DELIVERED outcome, held
  constant across `not-delivered`/ambiguous/suppressed outcomes** — the natural
  increment-per-`fire()` would give the ambiguous re-fire a NEW seq and make E1 a no-op, and
  an in-memory counter resetting on restart would collide the first post-restart heartbeat
  with a pre-restart entry and silently suppress it, undermining the flagship
  restart-durability proof. (The deployed beacon advances `lastHeartbeatAt` on every check,
  sent or not — `PromiseBeacon.ts:784-800` — so the ambiguous "retry" IS the next scheduled
  tick; holding `sendSeq` constant across it is what makes that tick match the guard.) §10
  pins: a beacon retry whose interpolated text differs IS suppressed (same logical send); the
  NEXT delivered-then-scheduled heartbeat (new seq) is NOT; and the
  **restart-between-heartbeats test** — restart the server between two heartbeats → the
  post-restart heartbeat is NOT suppressed.
- **The dedup entry is recorded ONLY on a likely-posted outcome (R2-security-NEW-3).** The
  entry is populated on success OR on an ambiguous/ack-lost outcome — NEVER on a clean
  transient failure where the funnel has positive evidence the message did not post (Slack
  5xx / connection refused before the request was accepted). Recording on ATTEMPT would make
  a clean-transient retry falsely suppressed → SILENT loss of the heartbeat. §10 pins the
  distinction: clean transient failure → retry NOT suppressed; ambiguous → single post.
- **The dedup map is BOUNDED (R2-security-NEW-4 / scalability-2) — scoped per R4-M2:** the
  in-memory CACHE reuses the §5.2 `AttentionTopicGuard` bounded/evicting structure (hard cap
  + `evictStaleSources`) — never a monotonic map — but eviction applies ONLY to
  retired/TTL-expired entries; an unretired entry is never evicted below the TTL (the durable
  journal record is the authority regardless — see the durability bullet above); the §10
  burst test asserts the bound AND that a burst never evicts a live unretired entry.
It is length-gated exactly like the Telegram dedup (brief acks never suppressed) and
bypassable with `allowDuplicate` for the rare genuine resend — **with a structural guard
(R3-minor): a CI assertion pins that the BEACON path never sets `allowDuplicate` (symmetric
with the `deterministicKind` allowlist); only a deliberate operator-driven resend may.** §10
pins the idempotency test (ambiguous-outcome resend at the real backed-off cadence → single
post).

**Owning-machine vs lease-holder gate (integration-F2; citation corrected per R3-minor).** In
today's single-Slack-machine / one-awake-machine reality the Slack socket lives on the awake
machine, which IS the lease holder, so the funnel's `ownsConversation(id)` gate (§5.0) and the
beacon's own per-fire ownership gate COINCIDE — this is a no-op today. **The gate that decides
which machine DELIVERS is `fire()`'s ownership gate (`PromiseBeacon.ts:590-605` — the WS3
`speakerElection.decide` verdict, failing toward speech), NOT the external-block sweep gate
the round-3 text cited (`:522-523`).** The funnel composes with it as the second, minted-id-
aware predicate: fire()'s election answers "does this machine speak for this topic";
`ownsConversation(id)` answers "can this machine actually resolve + deliver this minted id" —
both must pass. In a FUTURE active-active multi-machine-Slack world (§9's
`stateSync.conversations` posture) the single lease-holder is not necessarily the machine
holding a given conversation's socket, so a lease-holder beacon could deliver to a minted id
it does not own → a by-design non-owning typed-failure that must NOT arm §5.1's N-fail
dead-letter. Reconciling lease-holder with conversation-owner for active-active Slack is an
explicit tracked Phase-2.x follow-up (§11.2); until then, §5.1's dead-letter counter is
scoped to REAL delivery failures on the owning machine, never a by-design non-owning-machine
refusal. **This scoping is pinned NOW by a test (§10): a non-owning-machine typed-failure
NEVER increments the dead-letter counter; only an owning-machine real delivery failure does.**

**Non-owning beacon STAND-DOWN + the §11.2 correctness blocker (R3-M16 — the external
GPT-tier reviewer's structural-tension flag: increment 9 puts registry replication in Phase 1
while owner/lease reconciliation is deferred to §11.2).** Two concrete teeth close the gap
the deferral left open:
- **Stand-down, defined (not just "skip the dead-letter").** With increment 9 live, a
  replicated commitment can sit on a machine that does NOT own its conversation. That
  machine's beacon does not retry-forever into typed failures (a silent wasted loop): on a
  non-owning typed failure the commitment's beacon enters a **STAND-DOWN state — no re-fire
  scheduling — re-evaluated on a bounded ownership recheck riding the beacon's EXISTING
  external-block sweep (R4-minor-4 — the sweep is now NAMED, so the latency claim is
  falsifiable: `externalBlockSweepMs`, default 3,600,000 ms = hourly, lease-gated —
  `PromiseBeacon.ts:518-527`; the recheck is one O(active-stood-down) pass appended to that
  sweep, no new timer)**, so a machine that BECOMES the owner (adoption on first
  authenticated inbound, §3.5) picks the beacon up within one sweep interval (default ≤ 1 h).
  **The pickup deliverer reconstructs the bind-pin from the commitment's record-carried
  `boundTuple` (§3.5.2 property 5 — R4-M1): pickup delivery is `resolve(boundTuple)`, never
  bare `resolve(id)`, so an ownership migration cannot reopen the C3-class misdelivery the
  pin exists to prevent.** The dead-letter counter is never armed (the scoping above).
- **Active-active double-delivery is a CORRECTNESS blocker for §11.2, not an efficiency
  note.** Two machines each holding a live Slack socket can BOTH satisfy
  `ownsConversation(id)` → double-post. Until §11.2 lands, the increment-9 emitter carries a
  STRUCTURAL tripwire: if `>1` pool machine reports a live Slack adapter while
  `stateSync.conversations` is enabled, the conversations emitter **HOLDS** (entries stay
  machine-local — exactly the §3.1 unpinned-workspace hold mechanism) + ONE deduped attention
  item names the blocker ("active-active Slack needs the §11.2 owner/lease reconciliation").
  Single-socket fleets (today's reality) never trip it; the replicated-store increment
  degrades safely instead of double-posting.

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
- PromiseBeacon's `fire()` re-arms in `finally` and, after **`deadLetterAfterConsecutiveFailures
  = 3` consecutive `not-delivered` results (R3-M15 — previously an unpinned "N" that made the
  §10 N-fail test unimplementable; distinct from `deadLetterAttentionAfter = 1`, which dedups
  the ATTENTION item once the dead-letter state is reached)**, escalates via `raiseAttention`
  — so a funnel failure can never silently kill
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
  P17):** terminal dead-letters within one coalescing window (**pinned
  `coalescingWindowMs = 60000` — R3-minor, previously unpinned; the same 60 s window the §3.5
  ingest-refusal aggregator uses**) collapse into ONE summary
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
  **Reachability FLAP dampening (R3-minor — a channel bouncing archived↔unarchived would
  otherwise emit a fresh cross-window dead-letter attention per episode):** a conversation
  whose `reachability` flips more than `flapThreshold = 3` times within
  `flapWindowMs = 86400000` (24 h) enters a dampened state — further flips in the window
  update state silently, and its dead-letter attention coalesces to ONE per-window flap item
  ("conversation X is flapping between reachable/unreachable") instead of one per episode.

**§5.2 Bounded notification surface (P17 — lessons-F8).** The funnel is the ONE chokepoint
every migrated consumer rides, so the per-conversation delivery budget lives HERE: `id < 0`
deliveries carry a per-conversation rate budget + aggregation rule. Its state REUSES the
`AttentionTopicGuard` structure directly (scalability-F3) — a windowed `Map` with a
`maxTrackedSources`-equivalent hard cap AND `evictStaleSources` — so the budget state is
bounded by ACTIVE conversations per window, NOT a monotonic map keyed by every conversation
ever delivered to (which would grow to 100k+ at the §3.4 ceiling). **Pinned values (R3-M15 —
previously structure-only, leaving the §10 burst test with no bound to assert):**
`windowMs = 600000` (10 min); `perConversationPerWindow = 12` funnel deliveries per
conversation per window (overflow coalesces into ONE summary message per conversation per
window). **AND a GLOBAL cross-conversation ceiling at the same `id<0` arm (R3-M11 — P17's own
lesson says per-source budgets alone are dodgeable: the 2026-06-05 flood gave every item a
unique source, and the deployed Telegram analog carries both `maxTopicsPerSource` AND
`maxTopicsGlobal`): `globalPerWindow = 60` total `id<0` funnel deliveries per window**;
overflow beyond the global ceiling coalesces into ONE overflow notice naming the count + the
top emitters — so a buggy emitter fanning one item across N DISTINCT minted conversations
hits the ceiling even though every per-conversation budget passes. A flood of attention
items or reap notices on minted ids coalesces into a bounded Slack stream, not the
2026-05-22/05-28/06-05 topic-flood shape. §10 adds BOTH burst shapes: 1,000 items on ONE
minted id → bounded messages; and 1,000 items each to a DISTINCT minted conversation →
bounded total + one coalesced overflow notice (the dodge shape).

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
| 12 | Working-set carrier / profile acquire seam | `Number(cmd.session)` + `Number.isFinite` gates (`server.ts:18213-18219`); `onTopicAccepted(topic: number)` (`WorkingSetPullCoordinator.ts:117`) | At the onAccepted seam: non-numeric sessionKey → `registry.idForSessionKey(key)` **defined as get-or-create** (a named mint chokepoint) → fire the carrier with the minted id. **Acceptance criterion (R3-minor — the key-space claim is proven, not assumed): increment 7's test drives a minted-id topic through placement + journal nomination and asserts the carrier/nomination records exist under `String(<minted id>)` — that test, not this row, is what earns the "Slack conversations join Goal-2 transfer machinery" claim.** |
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
   session's commitment carries the minted id AND the denormalized bind-time `boundTuple`
   (§3.5.2 property 5 — R4-M1); beacon heartbeats deliver through the
   funnel into the exact thread; fire() re-arm + typed-failure contract (§5.1), the §7
   stateless bind token (R4-M3), the atomic seq-bearing hot-state write (R4-minor-1), and
   the durable E1 journal ops (R4-M2) land here.
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
   Slack" unqualified.** **One more honesty sentence (R3-minor — the 2026-07-01 silent-loss
   lesson has no stated Slack counterpart): every path in this spec rides the SlackAdapter's
   fail-closed authorized-sender gate, and a fail-closed gate over a DEGENERATE sender
   registry (never-populated, corrupt, or emptied-by-deletion) walls the operator out
   silently — the exact Telegram incident. The Slack gate's never-populated-vs-emptied
   discrimination and fail-toward-delivery-on-fresh-install treatment are OWNED by the
   Phase-2.2/3.1 ingress lane (§11.2/§11.3), not this spec — named here so the floor's
   dependency on a healthy sender registry is explicit, not discovered in an outage.**
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
inside the batched-save window and under the §3.3 mint-rate breaker — **but the REAL flood
protection here is the authorized-sender adoption gate below, credited correctly (R3-minor —
the round-3 text credited the breaker, which is per-CHANNEL while adoption mints exactly one
entry per channel, so the breaker barely engages on this path).** Because Slack auto-join
makes registry growth reachable by an unauthorized workspace member (a channel appears in the
registry without any authorized-sender activity), adoption is **gated to channels with ≥1
authorized-sender message on record — "on record" meaning the `MessageStore` (the deployed
cross-platform message persistence layer), the NAMED source store (R3-minor: previously no
store was named, leaving the gate uncheckable)** — a channel that only exists because the bot was auto-added
is NOT pre-minted (it mints lazily on its first authorized inbound, the same gate all mints ride).
The auto-join→registry-growth coupling is called out in the §3.4 growth-honesty section: adoption
is a pre-population convenience, not an unbounded-growth vector.

**Rebuild after registry loss (scalability-S2, adversarial-A5, security-m3, lessons-F10):**
recovery order is (1) restore BOTH `state/conversation-registry.json` AND the retained
`conversation-registry.jsonl*` set from BACKUP (both are in the manifest, §3.4 C1 — the
stateDir-root pin, R3-C4), then
replay any journal tail with `seq > snapshotHighWaterSeq` (primary path — snapshot + tail
compose to the exact pre-crash state); (2) if there is NO backup but the local journal survived,
REPLAY `<stateDir>/conversation-registry.jsonl` (§8 — append-only, records every mint/probe/alias with
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
TOP-LEVEL journal GLOB `conversation-registry.jsonl*` into
`config.backup.includeFiles` (idempotent set-union, stateDir-relative — the §3.4/R3-C4
journal-path pin; the Tier-2 test asserts BOTH are present AND — through the real deployed
`BackupManager` — that the glob's expanded set is non-empty with every expanded file landing
in the created snapshot — C1/R2-integration-1/R3-C4; NO
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
  arbitrary foreign positive id → refused). A bind whose target
  id is neither the session's own bootstrap conversation nor a positive id it owns is REFUSED with
  a typed `conversation-bind-not-authorized` error + ONE deduped attention item — never silently
  delivered into the foreign conversation. §10 pins the cross-conversation-bind refusal test.

  **The enforcement PRIMITIVE is named (R3-M5 — code-grounded: as previously written the
  policy was unenforceable. `POST /commitments` reads `topicId` from the request body
  (`routes.ts:21786`) behind ONE shared Bearer token for every session
  (`middleware.ts:120+`); the request carries NO authenticated session identity, and
  `source`/`boundBy` are caller-supplied — the server could not determine WHICH session was
  calling, so "its OWN bootstrap context" had nothing to check against.)** The primitive: at
  session spawn the server mints a per-session **bind token**, delivered ONLY through the
  spawned session's environment/bootstrap context (the tmux `-e` env block the spawn already
  builds — `SessionManager.ts:2169-2210` region) — never over a route. **The token is
  SELF-AUTHENTICATING and validation is STATELESS (R4-M3 — the round-4 "server-side in-memory
  map, re-minted on respawn" is RETRACTED: sessions are tmux processes that OUTLIVE the
  server process, and the server restarts on every auto-update — an in-memory map plus the
  fail-closed unknown-token rule meant every restart refused every live session's minted-id
  binds until that session was respawned, a standing availability hole in the flagship
  proof-consumer path).** Shape:
  `bindToken = base64url(payload) + "." + base64url(HMAC-SHA256(bindTokenSecret, payload))`
  where `payload = { sessionName, bootstrapConversationIds, mintedAt }` and
  `bindTokenSecret` is a random 32-byte secret generated once at first boot and persisted in
  the stateDir (the same at-rest posture as `authToken` in config — plaintext machine-local;
  it authorizes only bind-scoping, never delivery or message content). A restarted server
  re-derives nothing and stores nothing per-session: it verifies the MAC and reads the
  bootstrap set FROM the token — so a live session's token remains valid across any number of
  server restarts, with no map to lose. A durable-state open (`POST /commitments`,
  working-set bind) targeting a MINTED id MUST carry the bind token; the server verifies —
  NEVER trusts a caller-supplied session name — and checks the target against the token's
  OWN bootstrap set. A missing/MAC-invalid token on a minted-id bind is the same typed
  `conversation-bind-not-authorized` refusal (fail-closed; positive Telegram ids keep their
  existing behavior until their branch migrates — §10 pins both branches). `boundBy` is
  recorded FROM the verified payload, never from the body. **Honest residuals:** (a) a
  respawned session gets a FRESH token but its old token stays cryptographically valid for
  the same bootstrap set — accepted (it grants nothing the session was not already granted;
  theft surface = the session's own env, which already holds the live token); (b) rotating
  `bindTokenSecret` (a deliberate operator lever, and the revocation story) invalidates ALL
  outstanding tokens — live sessions then hit the typed refusal + its attention item until
  respawned, a LOUD deliberate trade, never a silent side effect of a routine restart.
  **Server-internal callers are OUT of the token gate's scope (R4-minor-3):** the gate exists
  to stop a confused/buggy SESSION from binding into a foreign conversation; internal
  features that open commitments IN-PROCESS (the action-claim observer, scheduled jobs) are
  the server itself — they carry a server-self principal (`boundBy: "server:<component>"`)
  and do not traverse the route-level token check. An internal caller that reaches the
  HTTP route anyway (a job shelling out to curl) needs a session token like anyone else —
  the discriminator is the code path, not the caller's self-description. This ships as a
  named part of the proof-consumer increment (§6.1 step 2) — B7 without the primitive is a
  wish, not a gate. §10 adds the restart test: token minted at spawn → server restarts
  (session persists) → the session's next minted-id bind SUCCEEDS with the same token.
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
  applicable), **`label` sanitized exactly as the list route (R3-minor — §3.5 B3's "only
  render surface" claim covers BOTH `GET /conversations` AND `:id`; the same §10 escape test
  pins both)**; positive → `{ platform:'telegram', topicId, passThrough:true }`; unknown
  negative → 404 with the honest "never minted on this machine" body.
- `GET /conversations/resolve?key=…` (or `?sessionKey=…`) — forward lookup, mints NOTHING
  (read-only).
- `GET /conversations/health` — counts by platform/origin, alias count, adoption-pass
  state, `entryCount`, `fileSizeBytes`, quarantine state, last mint, mint-budget state.
  The e2e "feature is alive" target.
- `<stateDir>/conversation-registry.jsonl` (the §3.4/R3-C4 journal-path PIN — the stateDir
  ROOT, beside `shared-state.jsonl`; NOT the agent-home `logs/` root and NOT a stateDir
  subdirectory, because the deployed backup glob resolver only expands top-level
  trailing-star globs) — append-only audit of every mint/adopt/alias/probe/bind-pin/
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
  legacy copies for channel-level keys, and of slackRefreshBinding for thread keys; **and the
  frozen schema-v1 constants match their pinned values (`MAX_PROBE_DISTANCE = 64`, probe
  direction DOWN, HLC `physical` unit = ms-since-epoch, `HLC_ABS_MIN = 1767225600000`,
  `HLC_ABS_MAX = 4102444800000` — R3-M10)**.
- Probe: seeded collision → next-lower id; probe skips alias ids; both orderings converge
  post-merge; **the local probe loop is bounded by `MAX_PROBE_DISTANCE=64` (the SAME constant
  the ingest coherence check uses) — a >64 probe degrades to the pending-mint path, never a
  peer-un-ingestable id** (local-probe-distance ≤ ingest-bound invariant).
- **Local collision-class displacement (R2-adversarial-2; cross-class per R4-C1):** TWO
  tuples colliding at ONE candidate, minted locally in EITHER order, receive DISTINCT ids (no
  reverse-index overwrite), and the local assignment is byte-identical to what the §3.5.1
  merge computes for the same tuple set — the **shared-implementation equivalence test** (the
  same displacement function serves §3.3 and §3.5.1 step 2; feeding it the same tuple set
  through both entry points yields identical assignments). **PLUS the ADJACENT-class shape
  (R4-C1): two collision classes at `C` and `C−1`, two claimants each, minted locally in
  every arrival order → all four ids DISTINCT (the global taken set forbids the `C−2`
  duplicate the per-class rule produced), byte-identical to the merge's global-`≺` pass.**
  Also asserts `candidateCollides` performs
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
  discriminator is locally assigned)**; HLC absolute-window accept-or-quarantine (the
  compared `physical` is never value-clamped — A2); alias one-hop-only invariant.
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
  **AND the dodge shape (R3-M11): 1,000 items each addressed to a DISTINCT minted
  conversation → the `globalPerWindow` ceiling bounds the total + ONE coalesced overflow
  notice**; the per-conversation budget map evicts stale entries (bounded, not monotonic).
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
  - **Bind-pin overlay (R3-C1/C2/C3/M8 — replaces the round-3 sticky suite):**
    **merge-blindness** — the ≥3-machine fuzz suite runs WITH live local bind-pins present on
    colliding ids and asserts every assignment is byte-identical with and without the pins (a
    pin can never move a winner); **redirect correctness** — the §3.5.2 C3 walk: partition,
    A binds T1@C / B binds T2@C, heal → both registries byte-identical, A's beacon delivers
    into T1's thread, B's beacon delivers into T2's REAL thread via the pin (commitment
    `topicId` unmutated on both), exactly ONE deduped attention item per redirecting pin;
    **refcount (M8)** — two durable binds on one id, close one → pin holds; close the last →
    `bind-release` journals + pin released; **restart replay** — live pins restored from the
    journal in `seq` order; **wire-stripping** — a replicated record carrying any
    `sticky`/binding field has it STRIPPED on ingest, never applied.
  - **Skew-exemption / equal-R delivery (R2-adversarial-3, discipline per R3-M13):** an
    offline-then-RETURNING machine
    with a stale pool-relative reference ingests the same record set as an online peer and reaches
    byte-identical `resolve()` for every id (the conversations ingest is exempt from the
    pool-relative skew quarantine). An absolute-window quarantine is a TERMINAL drop applied
    identically on every machine (cursor advances); a pool-relative-held record waits in the
    per-origin SIDE-QUEUE with backoff + `quarantineRetryMax` — **the sustained-failure test:
    a permanently-held record never blocks its origin's later records, and exhaustion yields
    exactly ONE parked-aside + attention item (no wedge, no silence).**
  - **Forged `mintedBy`/`hlc.node` (B4):** cannot change the alias tiebreak winner (both are
    overwritten to the authenticated envelope origin on ingest).
  Plus: same-tuple/different-id → local alias, NEVER a foundation `recordConflict`;
  wiring-integrity regression asserts the 7 existing WS2 stores still surface conflicts unchanged;
  `adopted-replicated` copy witness-dominates (no self-conflict); a peer-forged
  `reachability:unreachable`/`origin` is neutralized on ingest. And the round-4 merge
  additions:
  - **Incremental ingest cost (R3-M3, cascade per R4-C1):** per-record ingest against a large
    seeded `R` performs bounded ops independent of `|R|` (the cand→claimants locator + the
    bounded cascade — no full recompute); bulk arrival drains the cascade ONCE per batch;
    **and the incremental cascade's output is BYTE-EQUIVALENT to a from-scratch full
    recompute over the same `R` — asserted on adjacent-class shapes where a re-resolved class
    changes a neighbor class's displacement (the exact coupling the round-3 one-class rule
    missed).**
  - **Cross-class no-duplicate-assignment invariant (R4-C1):** the ≥3-machine fuzz suite
    seeds MULTIPLE collision classes at adjacent candidates (walk-overlap shapes included)
    and asserts, on every machine and every permutation, that no id is assigned to more than
    one tuple — the §3.5.1 step-3 invariant checked EXPLICITLY, not implied. Plus the
    3-record ADVERSARIAL construction from the round-4 report: a crafted back-dated tuple
    colliding at a victim's candidate `C` (winning `≺`, displacing the victim) + a crafted
    two-record class at `C−1` → the victim's conversation and the attacker record must NOT
    both resolve to `C−2`; every id resolves to exactly one tuple.
  - **Collision-class stuffing (R3-M7):** ≤64 fabricated uncorroborated colliding records
    from one origin → only the `≺`-least `uncorroboratedClassCap = 16` enter `R`
    (deterministically on every machine), the victim's legitimate local mint still lands
    within `MAX_PROBE_DISTANCE` (never forced to pending-mint), and the evictions land in the
    aggregated refusal item.
  - **Ingest-refusal aggregation (R3-M12):** N distinct malformed/seize/colliding/quarantined
    records from one origin within the 60 s window → exactly ONE aggregated attention item
    (origin + per-class counts + bounded key sample), never N items.
  - **Alias-repoint amplification bound (R3-minor):** a worst-case-ordered deep collision
    class heals with ≤ O(k²), k ≤ 64, journal re-point lines — asserted, not assumed.
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
  measured collision count within the §3.3 birthday band, or apply the chi-square /
  bucket-occupancy uniformity metric over the hash outputs **at the §3.3 pinned parameters
  (≥10k ids, ≤4,096 buckets, p < 0.01 — R3-minor)** (a "thousands"-sized
  count-the-collisions corpus expects <1 collision and proves nothing); a material
  overshoot / non-uniformity is the §11.9 wider-space trigger.
- **Cross-conversation bind refusal (B7, R2-security-NEW-5, primitive per R3-M5):** a
  `POST /commitments` whose
  `topicId` is not the session's own bootstrap conversation (nor a positive id in its
  authenticated bootstrap context) is REFUSED (`conversation-bind-not-authorized`) + attention
  item, never delivered into the foreign thread — BOTH branches pinned: own bootstrap topic
  (positive or minted) → allowed; arbitrary foreign positive id → refused. **The check runs
  through the §7 bind token: a minted-id bind with a MISSING or MAC-INVALID token is refused
  fail-closed; a bind presenting session A's valid token against session B's bootstrap
  conversation is refused; `boundBy` is asserted to come from the verified payload, never the
  request body; a TAMPERED payload (bootstrap set edited, MAC stale) is refused. And the
  R4-M3 restart-survival test: token minted at spawn → the SERVER restarts while the tmux
  session persists → the session's next minted-id bind with its ORIGINAL token SUCCEEDS (no
  respawn required); rotating `bindTokenSecret` → the same bind is refused with the typed
  error + attention item (the loud deliberate trade, never silent). An in-process
  server-self open (R4-minor-3) bypasses the route gate and records
  `boundBy: "server:<component>"`.**
- **Recording-off bind refusal (R2-integration-§9):** with `recording.enabled:false`, a
  durable-state open on a MINTED id is refused (`conversation-recording-disabled`) + one deduped
  attention item; a positive Telegram bind still succeeds; re-enabling restores minted binds.
- **Mass-unreachable aggregation (R2-lessons-2):** N simultaneous permanent errors (bot removed
  from workspace) produce ONE aggregated attention item carrying the count + list — never N
  items (burst-invariant on the dead-letter emitter).
- **Gate-exempt allowlist (B2):** only the two blessed call sites pass a `deterministicKind`; a
  third is a CI failure; the arm's text is server-side-templated per kind.
- **Ambiguous-outcome idempotency (E1, R2-lessons-1 / R2-security-NEW-3 / R2-security-NEW-4;
  retirement-based per R3-M1/M2):**
  an ambiguous `not-delivered` on an id<0 send that actually posted does NOT double-post — the
  per-`(conversationId, logicalSendId)` retirement-based entry suppresses the beacon's
  re-fire **at the REAL backed-off cadence (the test re-fires at the 6-hour `maxCadenceMs`
  cap AND at the 40-min atRisk-doubled cadence — never a sub-window fast retry), with
  interpolated elapsed/liveness text differing between attempts
  (same logical send → still suppressed)**; the NEXT delivered-then-scheduled heartbeat (new
  send seq) is NOT
  suppressed; **the restart-between-heartbeats test (M2): restart the server between two
  heartbeats → the durable `sendSeq` does not reset and the post-restart heartbeat is NOT
  suppressed**; **the restart-DOUBLE-POST test (R4-M2 — the direction the round-4 suite
  missed): ambiguous outcome recorded → server restarts inside the re-fire gap → the SAME
  logical send re-fires at the backed-off cadence → STILL exactly ONE post (the journaled
  `ambiguous-send` entry survived the restart)**; a CLEAN transient failure (5xx, never
  posted) is NOT recorded and
  its retry is NOT suppressed (distinct from ambiguous → single post); entries retire on
  delivered outcome / commitment close (journaled `send-retire`), with the 7-day TTL backstop
  asserted as safety-only;
  the dedup CACHE is bounded/evicting for retired/expired entries (burst-asserted) **and a
  burst never evicts a live UNRETIRED entry — cap-with-all-live sheds LOUDLY with one
  aggregated attention item (R4-M2)**; `allowDuplicate` bypasses — **and the
  CI assertion pins that the beacon path never sets it**; brief acks never suppressed;
  **the seq-bearing hot-state write is atomic tmp→rename (R4-minor-1 — a simulated torn
  write never yields a parseable file with a reset seq).**
- **Dead-letter scoping (I1):** a non-owning-machine typed-failure NEVER increments the
  dead-letter counter; only an owning-machine real delivery failure does. And the multi-machine
  cliff (>1 machine + CommitmentsSync live + `stateSync.conversations` dark) raises exactly ONE
  deduped boot attention item.
- **WAL crash-consistency** (§3.4 contract): torn-tail line discarded on replay; replay is
  idempotent (re-run any number of times → same state); snapshot high-water bounds replay to
  the tail; a crash mid-append never corrupts an earlier record; a crash mid-replay re-runs
  cleanly; **a replay SPANNING a rotation boundary applies records in the single global `seq`
  order — no skip, no double-apply — and the boot counter resumes from the max seen, never
  0/1 (R3-M14)**; **snapshot completeness (R4-M2 corollary): a snapshot taken after live
  bind-pins and unretired `ambiguous-send` entries exist, followed by pruning every
  superseded journal file, still restores pins AND dedup entries exactly.**

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
- **Backup manifest contains BOTH entries and the SNAPSHOT actually contains their files
  (C1, R2-integration-1/-2, R3-C4):** after
  the migrator runs, `config.backup.includeFiles` includes `state/conversation-registry.json`
  AND the top-level glob `conversation-registry.jsonl*`; then, after a durable mint, a
  snapshot is created **through the REAL deployed `BackupManager`** and the test asserts the
  glob's **EXPANDED file set is non-empty and every expanded file is PRESENT IN the created
  snapshot** (the literal `state/…json` entry asserted present in the snapshot the same way).
  The round-3 wording — "each entry resolves via the stateDir-join" — was unfalsifiable for a
  glob entry (the deployed resolver returns the literal string for unsupported shapes and
  `createSnapshot` silently skips it); a string-only/dead manifest entry FAILS this test. NO
  pre-backup flush hook is asserted (dropped —
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
   FULL §3.5.1 displacement rule including step 2(b)'s GLOBAL taken-offset set (one set
   across ALL collision classes, one global `≺` displacement order — R4-C1; the round-4
   per-class set is retracted as unsound),
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
   refused. Aliases are LOCAL-only, never ingested. **The merge reads NO local-lifecycle
   state — the round-3 `sticky` marker is REMOVED (R3-C1/C2/C3); durable-binding protection
   is the LOCAL, never-replicated §3.5.2 bind-pin overlay (delivery follows the bound TUPLE
   through the merge; consumer `topicId` never mutated; winner-flips unconditional).** The
   `≺` tiebreak reads the IMMUTABLE tuple
   byte-form, never the mutable key string (R2-adversarial-4, null-`threadTs` sorts first —
   R3-minor); the conversations ingest is
   EXEMPT from the pool-relative skew quarantine (its absolute HLC window is the
   machine-independent gate — R2-adversarial-3; absolute-window quarantine is TERMINAL,
   pool-relative retry is side-queued with P19 brakes — R3-M13)** — §3.5, §3.5.1, §3.5.2.
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
    stores); thread-level ids re-mint on next inbound or restore via the WAL. The journal
    lives at the stateDir ROOT (`<stateDir>/conversation-registry.jsonl`) with the top-level
    backup glob `conversation-registry.jsonl*` — the ONE glob shape the deployed
    `BackupManager.expandGlob` actually expands (R3-C4); `seq` is a single global monotonic
    counter across rotations and restarts (R3-M14); bind-pins ride the same journal
    (`op:"bind-pin"`/`"bind-release"`).** — §3.3, §3.4.
18. **The E1 guard is RETIREMENT-based with a DURABLE per-commitment `sendSeq` (advanced only
    on a delivered outcome, never reset by restart; the seq-bearing hot-state write is atomic
    tmp→rename — R4-minor-1) — no fixed dedup window races the beacon's real 6-hour backoff
    cap (R3-M1/M2) — and the dedup ENTRIES are durable too: `op:"ambiguous-send"`/
    `"send-retire"` journal lines riding the §3.4 WAL, with unretired entries never evicted
    below TTL (R4-M2).** — §5.0(a).
19. **Durable-binding protection travels WITH the binding: the bind-time tuple is
    denormalized onto the binding record (`boundTuple`, shape-clamped at the CommitmentsSync
    receive), so ANY machine delivering it — including the §5 stand-down/pickup path —
    reconstructs the pin at delivery time (R4-M1). And bind-token validation is STATELESS
    (self-authenticating HMAC token against a persisted `bindTokenSecret`), so tmux sessions
    that outlive a server restart keep binding without a respawn (R4-M3); in-process
    server-self opens bypass the route gate (R4-minor-3).** — §3.5.2 property 5, §5, §7.

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
findings resolved by the Round-3 revision (Appendix B); tags prefixed `R3-` map to the Round-3
findings resolved by the Round-4 revision (Appendix C); tags prefixed `R4-` map to the Round-4
findings resolved by the Round-5 revision (Appendix D). Provenance lives here; the design lives
above.

## Appendix B — Round-3 revision log (Round-2 findings → resolutions)

Applied from `docs/specs/reports/durable-conversation-identity-round2-findings.md`; every tag
below is traceable inline as `R2-<finding>`.

| Finding | Resolution |
|---|---|
| HIGH adversarial-2 (local mint omits merge step 2(b)) | §3.3 `candidateCollides` gains clause (c): a per-collision-class `≺`-ordered taken-offsets set — local mint and §3.5.1 step 2 share ONE displacement implementation, §10 equivalence-tested. |
| HIGH integration-1 (journal path ambiguous between two log roots) | §3.4 journal-path PIN: `<stateDir>/logs/conversation-registry.jsonl`; backup entry = stateDir-relative glob `logs/conversation-registry.jsonl*`; Tier-2 asserts manifest entries resolve to REAL files; §8/§6.2/§3.3 references updated. **(SUPERSEDED in Round 4 — R3-C4, Appendix C: that glob shape is dead against the deployed resolver; the journal now lives at the stateDir ROOT with the top-level glob.)** |
| HIGH lessons-1 (E1 window < beacon cadence; unstable content-hash key) | §5.0(a): window pinned as startup-asserted invariant `≥ max beacon re-fire + margin` (default 30 min); key = `(conversationId, logicalSendId=commitmentId+sendSeq)` with content-hash fallback; §10 test runs at the REAL beacon cadence with interpolated-text drift. **(SUPERSEDED in Round 4 — R3-M1/M2, Appendix C: the 30-min window loses to the real 6 h backoff cap; suppression is now retirement-based with a durable `sendSeq`.)** |
| MEDIUM scalability-1 (`candidateCollides` not pinned O(1)) | §3.3: each clause pinned O(1) (reserved-canonical lookup, alias lookup, bounded per-class set); §10 no-linear-scan assertion extended to the probe path. |
| MEDIUM security-NEW-3 (dedup entry recorded on attempt suppresses failed retry) | §5.0(a): entry recorded ONLY on success or ambiguous/ack-lost — never a clean transient failure; §10 pins the transient-vs-ambiguous distinction. |
| HIGH adversarial-1 / security-NEW-1 (collision-demotion strands a durable binding) | Sticky canonical: §3.5.1 `sticky(t)` marker (journaled + replicated, boolean-clamped, monotonic) — a durably-bound id is NEVER demoted; newcomers displaced; sticky-vs-sticky partition case falls back to `≺` + heal-forward repoint + ONE deduped attention; §3.4 entry field + §10 tests. **(SUPERSEDED in Round 4 — R3-C1/C2/C3/M8, Appendix C: the sticky marker broke merge determinism and is REMOVED; the underlying protection is delivered by the local §3.5.2 bind-pin overlay instead.)** |
| MEDIUM adversarial-3 (pool-relative skew quarantine breaks equal-R premise) | §3.5.1: conversations ingest EXEMPT from the pool-relative skew quarantine (the absolute HLC window is the machine-independent gate); any transport-quarantined record is RETRIED never cursor-skipped; §10 returning-machine test. **(REFINED in Round 4 — R3-M13, Appendix C: absolute-window quarantine is a terminal drop; the pool-relative retry gained a side-queue, backoff, a cap, and a loud terminal — the brakeless retry was a head-of-line wedge.)** |
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

## Appendix C — Round-4 revision log (Round-3 findings → resolutions)

Applied from `docs/specs/reports/durable-conversation-identity-round3-findings.md`; every tag
below is traceable inline as `R3-<finding>`. The sticky cluster (C1/C2/C3/M8) was resolved as
ONE design decision, exactly as the report recommended: durable-binding protection does NOT
belong in the merge input — the `sticky` marker is removed outright (never repaired) and
replaced by the local, never-replicated §3.5.2 bind-pin overlay.

| Finding | Resolution |
|---|---|
| **C1** (`sticky` breaks pure-function-of-R; unpinned sub-step composition) | `sticky(t)` REMOVED from the §3.5.1 algebra (no binding/lifecycle input exists to read); sub-step composition order PINNED (reservation → displacement → alias derivation, one ordered pass per class) with the unique-fixpoint statement + the restored invariant stated plainly (`assign : R → (tuple → id)` total deterministic function of R alone); §10 fuzz suite runs ≥3 machines WITH live bind-pins present and asserts pins never move an assignment. |
| **C2** (`sticky` expiry vs monotonic replication self-contradictory) | Dissolved by removal: the bind-pin overlay is machine-local and NEVER replicated, so its lifecycle is purely local-authoritative — there is no set-vs-clear partition state to converge (§3.5.2 property 4); any wire-arriving sticky/binding field is stripped at the §3.5 clamp. |
| **C3** (two-sticky partition unreconcilable — heal-forward would mutate `topicId` or alias one id to two targets) | The pin binds an id to its bind-time TUPLE; delivery follows the tuple to its CURRENT merge assignment (`resolve(pin.tuple)`), so the consumer's `topicId` is NEVER mutated and no id serves two conversations — the §3.5.2 partition walk shows both machines' bindings deliver correctly over byte-identical registries; winner-flips are unconditional (§3.5). |
| **C4** (backup-manifest glob `logs/conversation-registry.jsonl*` silently refused by the deployed `expandGlob`) | Journal RELOCATED to the stateDir ROOT (`<stateDir>/conversation-registry.jsonl`, beside `shared-state.jsonl`) with the top-level trailing-star glob `conversation-registry.jsonl*` — byte-parallel to the one deployed working precedent, zero shared-code change (extending `expandGlob` considered + rejected); §3.4/§6.2/§8/§10 references updated; the §10 Tier-2 test asserts the glob's EXPANDED set is non-empty and every expanded file lands IN the snapshot through the real deployed `BackupManager` (the round-3 "resolves via the stateDir-join" wording was unfalsifiable for a glob). Re-verified against this worktree's `src/core/BackupManager.ts` (expandGlob returns the literal for any `/`-containing pattern; `createSnapshot` existsSync-skips it silently). |
| **M1** (E1 window < the real 6h max beacon re-fire) | Suppression is RETIREMENT-based (§5.0(a)): a dedup entry persists until its logical send retires (delivered outcome / commitment close; 7-day TTL as safety only) — no window races the atRisk-doubled (40 min) or capped (6 h) cadence; §10 tests at the backed-off cadences. **(EXTENDED in Round 5 — R4-M2, Appendix D: the retirement-scoped entry is now DURABLE — journaled ambiguous-send/send-retire ops — with unretired entries never evicted below TTL.)** |
| **M2** (`logicalSendId` sendSeq had no durability/increment semantics) | `sendSeq` pinned durable + monotonic per commitment (persisted in beacon hot state), advanced ONLY on a delivered outcome, held constant across not-delivered/ambiguous/suppressed; §10 restart-between-heartbeats test (post-restart heartbeat NOT suppressed). |
| **M3** (merge had no complexity bound at ingest — O(N²) freeze risk) | §3.5.1: the pure function specifies the RESULT, not the strategy; application MUST be incremental per touched collision class (cand→claimants locator, §3.4 index 5), batch-resolve-once for bulk arrival; §10 bounded-ops ingest assertion. **(RESTATED in Round 5 — R4-C1, Appendix D: the one-class independence premise fails when displacement walks overlap; incrementality is now a bounded cascade.)** |
| **M4** (index inventory undercount: 2 declared, 4–5 required) | §3.4 full inventory: 2 synchronous + 3 DERIVED indexes (reserved-canonical map, per-class taken-offsets, cand→claimants), derived ones rebuilt-at-boot/never-persisted; resident-heap honesty updated (5–10× fileSizeBytes). **(SUPERSEDED in Round 5 — R4-C1, Appendix D: the per-class taken-offsets sets were UNSOUND as an occupancy structure and are replaced by ONE GLOBAL displaced-assignment set; per-class state survives only as the ordered locator.)** |
| **M5** (B7 bind-time authority had no enforcement primitive) | §7: per-session bind token minted at spawn (env/bootstrap-only delivery), server-side token→{session, bootstrapConversationIds} map, resolved server-side (never a caller-supplied name); missing/unknown token on a minted-id bind → fail-closed typed refusal; `boundBy` from the resolved token; ships with the proof-consumer increment; §10 pins the token branches. **(SUPERSEDED in Round 5 — R4-M3, Appendix D: the in-memory map dies with the server while tmux sessions don't; the token is now self-authenticating/stateless against a persisted secret.)** |
| **M6** (forged low HLC wins — back-dating threat undisclosed) | §3.5 back-dating threat-honesty paragraph (mirrors §3.3 birthday-honesty): registry shape IS peer-perturbable within the window, stated plainly; blast radius bounded by authority scoping (local-origin delivery, bind-pins, coherence/seize/class-cap); per-origin displacement-anomaly tripwire (`displacementAnomalyPerWindow = 8`/10 min) + aggregated refusals make the churn loud. |
| **M7** (collision-class stuffing → targeted pending-mint DoS) | §3.5 `uncorroboratedClassCap = 16` per collision class, `≺`-least selection (a pure function of the received set — convergence preserved); local-origin/corroborated records never capped; 16 + genuine ≪ 64 keeps the walk off the cliff; §10 stuffing test. |
| **M8** (`sticky` single boolean strands the second live binding) | The §3.5.2 bind-pin carries a live-binding REFCOUNT (`bind-pin`/`bind-release` journal ops); released only at zero; §10 refcount test. |
| **M9** (multi-workspace enforcement self-contradictory; global channel-id uniqueness unstated) | §3.1 restated at REAL strength: per-machine hard-refuse always; fleet-wide enforcement only WITH a config pin — `workspacePin` MANDATORY in multi-machine mode (emitter HOLDS concrete-workspace entries + one boot attention item when absent); the within-one-workspace channel-id uniqueness assumption stated explicitly, global uniqueness explicitly NOT assumed (Grid/Connect → Phase 7.1 schema-v2). |
| **M10** (HLC unit/epoch + absolute-window constants unpinned) | Pinned frozen schema-v1: `physical` = ms since Unix epoch; `HLC_ABS_MIN = 1767225600000` (2026-01-01Z), `HLC_ABS_MAX = 4102444800000` (2100-01-01Z); versioned-migration-only changes; 2100 horizon documented as a time-bomb requiring a pre-horizon re-pin; constants join the §10 golden-parity suite. |
| **M11** (P17 global ceiling missing at the funnel — the dodgeable half) | §5.2 `globalPerWindow = 60` cross-conversation ceiling at the `id<0` arm + coalesced overflow notice; per-conversation budget pinned (`perConversationPerWindow = 12`/10 min); §10 dodge-shape burst test (1,000 items × distinct conversations → bounded + one notice). |
| **M12** (ingest-side refusals not emitter-aggregated → peer-driven flood) | §3.5: ALL ingest refusal classes route through ONE aggregating emitter (60 s window, per-origin dedup, per-class counts + bounded key sample); the per-episode wording scoped THROUGH the aggregator; §10 burst test. |
| **M13** ("retried, never cursor-skipped" had no brakes — head-of-line wedge) | §3.5.1 quarantine discipline split: absolute-window quarantine = TERMINAL drop (pure content function, identical everywhere, cursor advances); pool-relative = per-origin SIDE-QUEUE with backoff (60 s ×2, 1 h cap), `quarantineRetryMax = 20`, LOUD park-aside + one attention item at exhaustion (honest unequal-R statement); §10 sustained-failure no-wedge test. |
| **M14** (WAL `seq` per-file vs global contradiction on the recovery path) | §3.4: `seq` is ONE global monotonic counter spanning rotations AND restarts; boot resumes from max seen (never 0/1); rotation carries the checkpoint anchor; §10 rotation-boundary replay test. |
| **M15** (convergence/test-critical defaults unpinned) | Dead-letter `deadLetterAfterConsecutiveFailures = 3`; §5.2 budget values pinned (12/window, global 60/window, 10-min window); the E1 "margin" term superseded by the retirement-based design (M1). |
| **M16** (lease-holder ↔ owner reconciliation deferred while replication is Phase 1) | §5: non-owning beacon STAND-DOWN defined (no re-fire scheduling; bounded ownership recheck per sweep); active-active double-delivery named a CORRECTNESS blocker for §11.2; structural tripwire — `>1` live Slack adapter + `stateSync.conversations` enabled → the emitter HOLDS + one attention item (degrade safely, never double-post). |
| ~25 MINORS (batch) | All folded: option-(b) chi-square parameters pinned (≥10k ids, ≤4,096 buckets, p<0.01); 60 s coalescing window pinned; journal rotation line cap (50k) + retention floor (≥2 backup cycles / 7 days) pinned; `pendingMintMax = 1000`; health threshold 80% (40k/8 MB); off-loop flush trigger (>20k entries / >2 MB); adoption-gate source store named (MessageStore); `HLC_ABS_MAX` horizon documented; null-`threadTs` sorts before concrete (byte-form empty string); alias-repoint O(k²) bound noted + §10-asserted; reachability flap dampening (3 flips/24 h → one flap item); beacon-path `allowDuplicate` CI assertion; flood-path neither-tuple-registered read = transport sessionKey; `op:"alias"`/bind-op replay idempotency stated seq-ordered; fire()-path ownership-gate citation corrected (`PromiseBeacon.ts:590-605`, not `:522-523`); `GET /conversations/:id` label sanitized + tested; adopted-replicated upgrade trigger collapsed to ONE wording (first authenticated inbound; delivery-time resolve never confers origin); working-set key-space claim converted to an increment-7 acceptance criterion; gate-exempt arm scope pinned (skips ONLY the tone gate; substitutions never peer-sourced); `getWorkspaceId()` honesty note (config read, not live auth; dormant-corroboration consequence stated); §6.2 adoption-flood credit corrected to the authorized-sender gate; mint-breaker budget map bounded; "coalesce" = batching never lossy; macOS fsync footnote (F_FULLFSYNC named); `supervision` frontmatter key added (the conformance-gate flag's declarative fix); `lessons-engaged` invented names marked spec-local/canonical; Slack degenerate-sender-registry honesty sentence (§6.1-3, owned by Phase-2.2/3.1); codex-R3-#3 SQLite-projection comparison added (§3.7); codex-R3-#5/gemini-R3-#1 normative core extracted (§3.0); gemini-R3-#2 any-durability-incident migration trigger endorsed (§3.7); gemini-R3-#3 statistical test treated critical-path driving §11.9 (§3.0). |

## Appendix D — Round-5 revision log (Round-4 findings → resolutions)

Applied from `docs/specs/reports/durable-conversation-identity-round4-findings.md`; every tag
below is traceable inline as `R4-<finding>`. Every code claim in the resolutions was
re-verified against THIS worktree's source (`CommitmentsSync.ts:149-155` clampReplicatedRow,
`PromiseBeacon.ts:518-527` external-block sweep default + `:1408-1411` non-atomic
saveHotState, `StateManager.ts:521-530` tmp→rename, the tmux `-e` spawn env block in
`SessionManager.ts`).

| Finding | Resolution |
|---|---|
| **C1** (cross-collision-class displacement overlap — two displaced tuples from ADJACENT classes take the SAME id under the per-class taken-offsets rule; convergent-but-wrong, 3-record adversarial construction inside the M7 threat model) | ONE coherent rule, not a patch: the taken-offsets set is GLOBAL. §3.5.1 step 2 restated — ALL displaced tuples across ALL classes are processed in ONE GLOBAL `≺` order against ONE global taken set (initialized to the reserved canonicals; each assignment enters the set exactly once, so "no id resolves to more than one tuple" holds BY CONSTRUCTION across classes). §3.3 clause (c) + §3.4 index 4 aligned to the global structure (per-class state survives only as the cand→claimants LOCATOR, now ordered for range queries); the fixpoint paragraph's "per collision class" evaluation order corrected. R3-M3's "touches exactly ONE class" incrementality premise RETRACTED and restated as a deterministic BOUNDED CASCADE over the walk-overlap closure (influence propagates only within a 64-wide window; adversarial chaining costs the attacker ≥1 record per window → amortized O(1) per ingested record). §10 additions: adjacent-class local-mint shape, cross-class no-duplicate-assignment invariant in the ≥3-machine fuzz suite, the 3-record adversarial construction, and cascade-vs-full-recompute byte-equivalence. |
| **M1** (the bind-pin is machine-local but §5's stand-down/pickup path lets a DIFFERENT machine deliver the replicated commitment with no pin → C3-class misdelivery on ownership migration) | §3.5.2 property 5: the bind-time tuple is DENORMALIZED onto the durable binding record itself (`boundTuple`, written at bind time by the same WAL-fsynced open) so ANY machine delivering the binding reconstructs the pin at delivery time (`resolve(boundTuple)`, uniform rule; legacy records fall back to `resolve(id)`). Shape-clamped at the CommitmentsSync receive chokepoint; grants no authority `topicId` does not already grant (delivery still requires §5.0 ownership + local-origin resolution). The §3.5.2 residual sentence corrected to name the pickup path; §5 stand-down pickup delivers via `boundTuple`; §10 ownership-migration pickup test (bound on A, adopted by B, merge demotes → B lands in the bound tuple's real thread). |
| **M2** (the E1 dedup entry is long-lived by design but lived in an in-memory bounded/evicting map — a restart or cap eviction wipes it → the exact double-post E1 exists to prevent) | The entry is DURABLE: `op:"ambiguous-send"`/`"send-retire"` journal lines riding the §3.4 WAL discipline (fsynced — a durable-binding-class write), replayed idempotently at boot; the journal's ≥7-day retention floor equals the entry TTL by construction; the in-memory map becomes a cache. An UNRETIRED entry is NEVER evicted below TTL (eviction applies to retired/expired only; cap-with-all-live sheds LOUDLY with one aggregated item). Snapshot-completeness corollary made explicit (§3.4): the snapshot persists live pins + unretired dedup entries, so rotation pruning can never lose them. §10: the restart-DOUBLE-POST direction (ambiguous → restart → re-fire → still ONE post) added alongside the existing false-suppression direction. |
| **M3** (the bind-token map is in-memory "re-minted on respawn" but tmux sessions OUTLIVE the server process — every auto-update restart fail-closes all live sessions' minted-id binds until respawn) | §7 primitive rebuilt STATELESS: `bindToken = base64url(payload)."."base64url(HMAC-SHA256(bindTokenSecret, payload))` with `payload = {sessionName, bootstrapConversationIds, mintedAt}` and a random 32-byte `bindTokenSecret` persisted in the stateDir at first boot — a restarted server verifies the MAC and reads the bootstrap set FROM the token; no per-session server state exists to lose. Honest residuals stated (an old token stays valid for the same bootstrap set — grants nothing new; secret rotation is the loud deliberate revocation lever). §10 restart-survival test (server restarts, session persists, original token still binds) + tamper/rotation refusal tests. |
| minor-1 (`sendSeq` "journaled with it" overstated the medium — saveHotState is a plain non-atomic writeFileSync) | Retracted and re-pinned: the seq-bearing hot-state write MUST be atomic tmp→rename (the `StateManager.ts:521-530` house pattern), named in the proof-consumer increment; §10 torn-write assertion. Composition with the durable R4-M2 entry (a reset seq re-colliding with a durable entry) named as the reason this is now load-bearing, not polish. |
| minor-2 (pool-relative side-queue cardinality unbounded) | `quarantineSideQueueMax = 256` held records per origin; past the cap a record parks-aside IMMEDIATELY (same loud terminal as exhaustion, counted in the aggregated refusal item). |
| minor-3 (server-internal callers of minted-id binds have no bind token) | Pinned: in-process server-self opens (action-claim observer, scheduled jobs) bypass the ROUTE-level token gate and record `boundBy: "server:<component>"`; anything arriving over the HTTP route needs a session token regardless of self-description — the discriminator is the code path. |
| minor-4 (stand-down recheck sweep unnamed — pickup latency unfalsifiable) | Named: the recheck rides the beacon's EXISTING external-block sweep (`externalBlockSweepMs`, default 3,600,000 ms = hourly, lease-gated — `PromiseBeacon.ts:518-527`), one O(active-stood-down) pass appended, no new timer; pickup latency ≤ one sweep interval (default ≤ 1 h). |
| minor-5 (`workspacePin` "replicated single-writer fleet value" naming over-promises) | Renamed "replicated pin CANDIDATE, corroboration-gated" with the explicit anti-instruction (an implementer must NOT build an actual single-writer register; under conflict each machine keeps minting under its locally-authenticated teamId). |
