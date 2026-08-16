---
source: Echo (echo agent)
date: 2026-05-07
purpose: Parallel Instar audit matching Dawn's OpenClaw audit
openclaw_commit_audited: f482e4d335 (matches Dawn's audit commit)
status: review-pending — §9 to Justin first
related: .claude/research/openclaw-audit-dawn-handoff-2026-05-07.md
---

# OpenClaw → Instar Parallel Audit

This audit is the Instar-side mirror of Dawn's OpenClaw audit. Same 10-section structure. Justin's brief: §9 is the most important section — it explicitly calls out where Instar is MORE evolved than OpenClaw so we don't downgrade by importing patterns we've already surpassed.

## TL;DR

OpenClaw is a horizontally-scaled gateway (~30,500 commits, ~250 plugins, multiple agents per gateway, dozens of channels). Instar is a vertically-integrated single-agent runtime (29 jobs, deep ledger/coherence stack, multi-machine coordination). They optimize for different things:

- **OpenClaw is a platform**. The strongest primitives are workflow/concurrency machinery (TaskFlow, queues, hooks, runtimes) and structured-knowledge plumbing (WikiClaim, dreaming).
- **Instar is an integrated being**. The strongest primitives are integrity machinery (SharedStateLedger v2, signal-vs-authority gates, MessageSentinel, ExternalOperationGate) and multi-machine continuity (Heartbeat, JobClaim, MachineIdentity).

Worth importing from OpenClaw: TaskFlow as a managed-flow primitive, WikiClaim's evidence schema, dreaming's six-signal weighted gate, llm-task as a typed-JSON tool, the `before_prompt_build` plugin hook surface, the queue's `steer-backlog` pattern.

Not worth importing: OpenClaw's commitment record (Instar's is more rigorous — see §9), OpenClaw's heartbeat-as-delivery-channel (Instar's heartbeat is multi-machine consensus), OpenClaw's plugin-based memory backends (Instar's typed entity graph is structurally different and superior for relationships), Markdown-file-based memory (Instar's SQLite + JSONL durability log is operationally safer).

---

## §1 Architecture overview

OpenClaw architecture: single Gateway daemon owns all messaging surfaces; control-plane clients (mac app, CLI, web) and Nodes (devices) connect over a typed WebSocket protocol; canvas + A2UI served on the same port; one Gateway per host. Plugin extensions add provider runtimes, memory backends, channel adapters, and tools. Multiple agents in one gateway, with bindings routing inbound messages to specific agents. Source: `docs/concepts/architecture.md:9-50`.

Instar architecture: single Express server per agent (port 4042 default), lifeline supervises the server process plus auxiliary processes via launchd, multi-machine coordination via Heartbeat + JobClaim. State is filesystem-anchored (`.instar/`) and git-versioned for cross-machine sync. Modules: `src/core/` (60+ classes for ledger, gates, trust, coherence), `src/scheduler/` (jobs), `src/threadline/` (agent-to-agent network), `src/memory/` (SemanticMemory + EpisodicMemory + TopicMemory + WorkingMemoryAssembler), `src/messaging/` (channel adapters), `src/server/` (HTTP API).

Key topology difference: OpenClaw is one process with many plugins and many agents, Instar is one process per agent with many primitives and one agent. OpenClaw scales horizontally across personas; Instar scales the agent's depth-of-self.

Both share: cron/job scheduler, channel adapters, durable transcripts, plugin-style hook surface (Instar via `.claude/hooks/`, OpenClaw via plugin SDK).

## §2 TaskFlow

OpenClaw TaskFlow (`src/tasks/task-flow-registry.ts:376-586`):
- Record shape: `{flowId, syncMode, ownerKey, controllerId, revision, status, notifyPolicy, goal, currentStep, blockedTaskId, stateJson, waitJson, ...}` (`task-flow-registry.types.ts:24-43`).
- Statuses: `queued | running | waiting | blocked | succeeded | failed | cancelled | lost`.
- All mutations require `expectedRevision` (optimistic concurrency); revision conflicts return `{applied: false, reason: "revision_conflict", current}` (`:440-464`).
- Lifecycle: `createManagedTaskFlow → updateFlow → setFlowWaiting({waitJson:{kind:...}}) → resumeFlow → finishFlow / failFlow / requestFlowCancel`.
- SQLite-backed (`task-flow-registry.store.sqlite.ts:361-371`) with `BEGIN IMMEDIATE` transactions.

Instar equivalent: there isn't one with this shape. Initiative tracking lives in `src/core/InitiativeTracker.ts`, the bug-cluster pipeline lives in `src/core/EvolutionManager.ts` + skip-ledger, work-ledger entries are append-only `src/core/SharedStateLedger.ts`. None of these have:
- Optimistic-concurrency revision mutations
- Typed wait reasons (`{kind: "reply"|"human-review"|"external-call"}`)
- A controller-owned managed-flow lifecycle

Worth importing: TaskFlow is genuinely new for Instar. The bug-cluster pipeline (cluster → tier-1 fix → ratification → tier-2 expansion) maps cleanly onto a managed flow with `controllerId=Echo`, `currentStep="tier-1-fix"`, `waitJson:{kind:"human-review", who:"Justin", topic:21721}`. It would replace ad-hoc state-shuffling between the cluster, the dispatch executor, and the handoff manager.

Open question (Dawn's #1): whether `BEGIN IMMEDIATE` provides multi-process atomicity. Confirmed yes for *writes* (SQLite locks the database for the duration of the transaction), but the in-memory `flows` Map cache (`task-flow-registry.ts:432-438`) means readers in another process see stale state until they reload. For Instar's likely use this is fine — only one process owns the controller — but the pattern needs to be documented if any sub-process ever writes.

## §3 Memory architecture

OpenClaw memory (`docs/concepts/memory.md`, `extensions/memory-wiki/`, `extensions/active-memory/`):
- **Markdown-file primary**: `MEMORY.md` (durable), `memory/YYYY-MM-DD.md` (daily), `DREAMS.md` (consolidation review).
- **Pluggable backends**: builtin SQLite, QMD, Honcho, LanceDB.
- **Tools**: `memory_recall`, `memory_search`, `memory_get`.
- **Active memory plugin**: pre-reply blocking sub-agent runs `before_prompt_build`, has 6 prompt styles (`balanced/strict/contextual/recall-heavy/precision-heavy/preference-only`), 3 query modes (`message/recent/full`), circuit breaker (3 timeouts → 60s cooldown), cache TTL (1-120s), cold-start grace (`setupGraceTimeoutMs`). Returns `{prependContext: string}` to the hook ABI (`extensions/active-memory/index.ts:2891, 2988`).
- **WikiClaim provenance**: `{text, status, confidence, evidence:[{sourceId, path, lines, weight, confidence, privacyTier, note}]}` (`extensions/memory-wiki/src/markdown.ts:17-100`).
- **Dreaming six-signal weighted promotion**: Frequency .24 / Relevance .30 / Diversity .15 / Recency .15 / Consolidation .10 / Richness .06; gates `minScore + minRecallCount + minUniqueQueries` (`docs/concepts/dreaming.md:99-107`).

Instar memory:
- **SQLite + JSONL append log** (no Markdown primary). `SemanticMemory` (`src/memory/SemanticMemory.ts:58`) with WAL journaling, `busy_timeout=5000`, JSONL alongside DB as DR source-of-truth (`:67-69`).
- **Typed entity graph**: `MemoryEntity { id, type:'fact'|'person'|'project'|'tool'|'pattern'|'decision'|'lesson', name, content, confidence, createdAt, lastVerified, lastAccessed, expiresAt, source, sourceSession, tags, domain, ownerId, privacyScope }` (`src/core/types.ts:2580-2614`).
- **Typed edges**: `MemoryEdge { fromId, toId, relation:'related_to'|'built_by'|'learned_from'|'depends_on'|'supersedes'|'contradicts'|'part_of'|'used_in'|'knows_about'|'caused'|'verified_by', weight, context }` (`:2562-2629`).
- **Layered**: SemanticMemory (entities/edges), EpisodicMemory (session digests), TopicMemory (topic-scoped), MemoryIndex (FTS5 + sqlite-vec hybrid), WorkingMemoryAssembler (token-budgeted assembly across all of the above).
- **Per-entity privacy scope** for multi-user isolation (`privacyScope?: PrivacyScopeType`, `:2613`).
- **Decay/expiry**: confidence decay job + hard `expiresAt` per entity.
- **Session memory flush**: assembled at session start by WorkingMemoryAssembler (`:97`); budgets default `knowledge:800, episodes:400, relationships:300, total:2000` tokens.

Worth importing FROM OpenClaw: WikiClaim's evidence schema. Instar's `MemoryEntity.source` is a single string ('session:ABC' | 'user:Justin'); WikiClaim's array of `{sourceId, path, lines, weight, confidence, privacyTier, note}` is materially better for tracing claims back to specific feedback reports / commit lines / log entries. This is exactly the "every bug cluster carries `claims:[{text, evidence:[{...}]}]`" use case Dawn flagged.

Worth importing: dreaming's six-signal weighted promotion as a model for promoting feedback-cluster signal → PROP. Instar's existing PROP queue currently uses single-axis frequency; multi-axis with required `minUniqueQueries` would catch the case where one user reports a bug 50 times but it's actually a 1-of-1 that should be triaged differently than a 5-of-50 with high diversity.

## §4 Multi-provider routing

OpenClaw model failover (`docs/concepts/model-failover.md`): two-stage — auth-profile rotation within current provider, then model fallback to the next entry in `agents.defaults.model.fallbacks`. Cooldowns: 1m → 5m → 25m → 1h cap, exponential. Billing-disable is a separate longer-backoff lane (5h → cap 24h). Session-stickiness pins the chosen profile per session for cache warmth. Selection-source policy distinguishes configured-default / agent-primary / auto-fallback / user-session-override / cron-payload, with strict rules for explicit user selections (no silent fallback to unrelated models). Live-session reconciliation persists the selected fallback override before retry to close the race where stale session state would snap back to the failed primary. Failure summaries include flat `fallbackStep*` fields for log reconstruction.

Instar equivalent: not present in this depth. Instar's intelligence-provider abstraction (`src/core/AnthropicIntelligenceProvider.ts`, `ClaudeCliIntelligenceProvider.ts`) selects a provider per-call from config; there's no cross-provider fallback chain, no auth-profile rotation, no cooldowns. This is a real gap when an Anthropic outage stalls all dispatch + sentinel + coherence-gate calls.

Worth importing: model-failover's structure (selection-source taxonomy, two-stage rotation with cooldowns, exhaustion summary error). Auth-profile rotation per-provider is overkill for Instar today (one user, one key), but the model-fallback chain is genuinely needed.

## §5 Channel runtime

OpenClaw channels (`docs/concepts/multi-agent.md`, `docs/concepts/channel-docking.md`):
- Channels: WhatsApp, Telegram, Slack, Discord, Signal, iMessage, IRC, Line, GoogleChat, Mattermost, Matrix, NextcloudTalk, BlueBubbles, Zalo, Nostr, Feishu, WebChat (~17).
- Multi-account per channel (e.g., two WhatsApp numbers).
- Bindings route `(channel, accountId, peer)` → `agentId` deterministically with most-specific-wins tie-breaking and AND semantics for multi-field matches.
- **Channel docking**: `/dock_discord` from a Telegram session moves the active session's reply route to Discord while keeping the same transcript. Requires `session.identityLinks` group membership for both source sender and target peer. Field-level: updates `lastChannel`, `lastTo`, `lastAccountId`. Source: `docs/concepts/channel-docking.md`.
- Group-chat mention gating per agent.
- Dispatch tied to a per-session lane (FIFO with global cap).

Instar channels (`src/messaging/`):
- Channels: Telegram (primary, bidirectional), Slack, iMessage, WhatsApp adapters present (`AdapterRegistry.ts`).
- Single agent per server, no agent bindings.
- Topic-scoped sessions (Telegram message_thread_id), with TopicResumeMap and ContextThreadMap maintaining cross-channel correlation.
- DropPickup pattern for handing off between adapters.

Worth importing: channel docking, when Instar moves to multi-channel routine use. The `/dock_<channel>` semantics + identity-links group membership is a clean primitive for "I'll keep the conversation context but change where you reply." Instar's TopicResumeMap already keys threads symmetrically — adding a dock-style verb would make moves between Telegram/Slack/iMessage practical.

## §6 Permissions / retries / sub-agents / sessions

OpenClaw:
- **Per-agent sandbox + tool allow/deny lists** (`agents.list[].sandbox`, `agents.list[].tools.allow|deny`).
- **Active-memory pre-reply sub-agent** with bounded tool allowlist (`memory_recall`, `memory_search`, `memory_get`), circuit breaker, cache TTL, cold-start grace.
- **Sub-agent transcripts** persist to a separate directory under each agent's sessions folder when `persistTranscripts: true`.
- **Queue modes**: `steer | queue (legacy) | followup | collect | steer-backlog | interrupt (legacy)`. Default `steer` with `debounceMs: 500, cap: 20, drop: summarize`. Per-channel and per-session overrides. (`docs/concepts/queue.md`).
- **Diagnostics state machine**: `session.long_running | session.stalled | session.stuck` with abort-drain only after `diagnostics.stuckSessionAbortMs` (default 10m, ≥5x warn). (`docs/concepts/agent-loop.md:168`).
- **Idempotency keys** required for side-effecting WS methods (`send`, `agent`); short-lived dedupe cache.

Instar:
- **AdaptiveTrust** per-(service, operation-mutability) with sources `default | config | user-explicit | earned | revoked`; trust floor `supervised | collaborative` that auto-escalation can never cross (`src/core/AdaptiveTrust.ts:28-90`).
- **ExternalOperationGate** three-tier: static classification (mutability × reversibility × scope → risk), config permissions, LLM evaluation for medium+ risk, integrated with AdaptiveTrust. Born from the OpenClaw email-deletion incident (`src/core/ExternalOperationGate.ts:1-22`).
- **MessageSentinel** in server process (separate from session), classifies every incoming user message via fast-path regex (≤MAX_FAST_PATH_WORDS) + LLM classification (haiku-tier, <500ms) → kill-session / pause-session / priority-inject / pass-through. Three-way ContinuePingIntent for gate-quality telemetry. Born from same incident (`src/core/MessageSentinel.ts:1-78`).
- **Sub-agents**: Echo's research/build/etc. via Claude Code Agent tool, with explicit specialist agent types (Explore, Plan, etc.) and Worktree isolation. No native sub-agent transcript-persistence layer in instar source — that's a Claude Code harness concern.
- **OutboundDedupGate** Jaccard 3-gram word similarity, sub-millisecond, runs on every outbound message; threshold 0.7, window 5m, min length 40 chars (`src/core/OutboundDedupGate.ts`).
- **No queue modes**. Instar serializes by topic-session via TopicResumeMap; there's no `steer / collect / followup` distinction. Inbound messages append to a topic queue, the agent processes the queue when it next runs.

Worth importing FROM OpenClaw: queue mode taxonomy (`steer/collect/followup/steer-backlog`). When two messages land while Echo is mid-reply, Instar currently has no clean grammar to express "fold both into one followup turn" vs "add this to the active turn before the next LLM call." The OpenClaw `steer` semantics + `collect` debounce solve that without extra infrastructure. Diagnostics state machine (`long_running/stalled/stuck`) is also worth modeling for Instar session telemetry.

## §7 Surprises

1. **Hook signature for active-memory**: confirmed via source — `before_prompt_build` returns `{prependContext: string}` to inject hidden untrusted-context prefix (`extensions/active-memory/index.ts:2988`). This is the exact graft surface that an Instar active-memory analog would need; Instar's existing context-hierarchy/working-memory paths already produce a comparable string but inject earlier (session start) rather than per-turn.

2. **TaskFlow uses BEGIN IMMEDIATE + in-memory cache**: SQLite locks for write atomicity (`task-flow-registry.store.sqlite.ts:363`), but the cached `flows` Map (`task-flow-registry.ts:432`) means cross-process readers see stale state until reload. Pragmatic but not multi-process-safe in the strict sense; Instar should not assume it can read flow state from a worker without a registry refresh API.

3. **Codex routing complexity is real**. The agent-runtimes doc enumerates 5 distinct Codex surfaces: native app-server runtime, OAuth profiles, ACP adapter, native chat-control commands, OpenAI Platform API for non-agent surfaces. The `agentRuntime.id` selector must distinguish all of them deterministically. Instar's intelligence-provider abstraction collapses this into one provider class per backend; OpenClaw's complexity here is a function of supporting many backends, not over-engineering.

4. **Failover summary error** carries per-attempt detail and the soonest cooldown expiry. Instar's intelligence-provider failures bubble up as raw error strings; the `FallbackSummaryError` shape (with flat `fallbackStep*` fields for log exporters) is a quietly excellent observability primitive.

5. **Active memory is fully OPT-IN per agent**: enabled flag + `agents:[]` allowlist + `allowedChatTypes:[direct|group|channel]` + `allowedChatIds:[]` + `deniedChatIds:[]`. Five-stage filter before any recall pass runs. This is more careful than Instar's current "always-on" working-memory assembly — though Instar's path is structurally cheaper because it runs at session start, not per-turn.

6. **Channel docking does NOT move transcript history** (`docs/concepts/channel-docking.md:117`). Only the reply-route fields change. This is the right design — moving transcripts would couple the dock command to backfill semantics — but easy to misread the first time.

7. **Dreaming runs phases in order light→REM→deep with only deep writing durable** (`docs/concepts/dreaming.md:111-117`). Counter-intuitive (REM-then-deep, not deep-then-REM). The reason: REM-phase reinforcement signals feed deep ranking via a recency-decayed boost from `phase-signals.json`.

## §8 Primitives worth importing for Instar

For each, citation in OpenClaw + the Instar surface that should consume it.

| # | OpenClaw primitive | OpenClaw cite | Instar surface that should consume it |
|---|---|---|---|
| 1 | TaskFlow managed-flow record | `src/tasks/task-flow-registry.types.ts:14-43`, `task-flow-registry.ts:376-586` | Bug-cluster → tier-1-fix → ratification → tier-2-expansion pipeline. Replace `EvolutionManager` ad-hoc state machine with controllerId=Echo managed flows. |
| 2 | WikiClaim evidence array | `extensions/memory-wiki/src/markdown.ts:17-29` | `MemoryEntity` provenance: replace flat `source: string` with `evidence: [{sourceId, path, lines, weight, confidence, privacyTier, note}]`. Lets clusters trace back to specific feedback IDs and source lines. |
| 3 | Dreaming six-signal weighted score | `docs/concepts/dreaming.md:99-107` | PROP-queue promotion: replace single-axis frequency with weighted Frequency/Relevance/Diversity/Recency/Consolidation/Richness + `minUniqueQueries` gate. Catches the "1 user × 50 reports" misfire. |
| 4 | llm-task JSON-only typed tool | `extensions/llm-task/src/llm-task-tool.ts:119-307` | Cluster severity scorer / dispatch decider should be a single Ajv-validated typed tool, not an inline prompt. Same shape: `{prompt, input, schema, provider, model, thinking, authProfileId, temperature, maxTokens, timeoutMs}`. |
| 5 | `before_prompt_build` plugin hook | `extensions/active-memory/index.ts:2891-2998` | Existing context-hierarchy injection happens at session start; a per-turn hook with bounded tool allowlist lets us add an active-memory pass for working-memory recall without touching the main prompt path. |
| 6 | Queue mode taxonomy | `docs/concepts/queue.md:39-56` | Per-topic queue: add `steer / collect / followup / steer-backlog` modes. Solves "two Telegram pings during an Echo reply" without ad-hoc batching. |
| 7 | Channel docking | `docs/concepts/channel-docking.md:39-105` | When Instar adopts multi-channel routine use: `/dock_<channel>` semantics with identity-links group, updates `lastChannel/lastTo/lastAccountId` only. |
| 8 | FallbackSummaryError shape | `docs/concepts/model-failover.md:313-326` | Intelligence-provider failures should bubble structured per-attempt detail + soonest cooldown expiry, with flat `fallbackStep*` fields for log exporters. |
| 9 | Cold-start grace knob | `docs/concepts/active-memory.md:628-660` | Any blocking pre-reply pass needs an explicit `setupGraceTimeoutMs` separate from the operation timeout. Instar currently conflates these. |
| 10 | Diagnostics state machine | `docs/concepts/agent-loop.md:168` | Session telemetry: classify long-running vs stalled vs stuck, abort-drain only at ≥5× warn threshold. |
| 11 | Sub-agent transcript persistence directory | `docs/concepts/active-memory.md:537-549` | When Echo's sub-agents need debug-replay, persist to `agents/<agent>/sessions/active-memory/<sub-id>.jsonl`, not main transcript. |
| 12 | Session pruning (cache-TTL-aware tool-result trimming) | `docs/concepts/session-pruning.md:28-45` | Soft-trim oversized tool results (head+tail+`...`), hard-clear the rest after 5-min cache TTL. Reduces Anthropic prompt-cache-write size, lowers cost. Instar has nothing equivalent — every session that lives past compaction pays full cache-write cost. |
| 13 | Parallel specialist lanes with explicit lane contracts | `docs/concepts/parallel-specialist-lanes.md:34-77` | When Echo grows into multi-lane work (research / build / dispatch in parallel), each lane needs a written contract: purpose / non-goals / chat-budget / handoff-rule / tool-risk-rule. Instar's sub-agent invocations today have implicit contracts in the agent-type description; making them explicit + enforced is high-leverage as the workload grows. |

---

## §9 Things NOT to import — where Instar is MORE evolved

**This is the section Justin asked to be most explicit.** For each OpenClaw primitive that looks similar to Instar at a glance, the actual Instar primitive is more rigorous and we should not downgrade.

### 9.1 Commitments — Instar's are vastly more rigorous

OpenClaw commitments (`docs/concepts/commitments.md`, `src/commitments/...`):
- Flat record `{agentId, sessionKey, channel, dueWindow, suggestedCheckin}`
- LLM extraction pass after eligible turns
- Heartbeat-delivered when due
- Dismissable with `HEARTBEAT_OK`
- Clamp: never delivered immediately after writing (≥1 heartbeat)
- Stored in local OpenClaw operational state

Instar commitments (Integrated-Being Ledger v2, `src/core/types.ts:1714-1777`, `src/core/CommitmentSweeper.ts`):
- Append-only ledger entries with `kind: 'commitment'`, never mutated in place
- **Required `LedgerMechanismSpec`**: every commitment declares HOW it will be fulfilled — `scheduled-job | polling-sentinel | external-callback | passive-wait | user-driven` — with an opaque `ref` resolved against a mechanism-type registry, server-bound `refResolvedAt` and `refStatus: 'valid' | 'invalid' | 'unverified'` (frozen at write).
- **Required counterparty metadata** so authority is unambiguous (no commitment is "to nobody").
- **Resolution tier**: when resolved, the resolution is tagged `self-asserted | subsystem-verified | user-resolved` so readers calibrate trust accordingly. OpenClaw has no equivalent — a resolved commitment has no provenance about how it was resolved.
- **Status transitions via supersedes pointers**, not in-place mutation. The original commitment stays `kind=commitment, status=open` forever; status changes happen by emitting new note entries that supersede it. **Both the original utterance AND the subsequent observation are independently auditable.** OpenClaw mutates the commitment record, losing the original utterance.
- **Separate `disputes` pointer** for "I disagree this commitment was made," distinct from `supersedes`. OpenClaw has no dispute model.
- **CommitmentSweeper is signal-shaped** (`src/core/CommitmentSweeper.ts:18-27`): the expired/stranded sweepers OBSERVE and EMIT NOTES; they do NOT mutate the commitment. The original `kind=commitment, status=open` row is preserved; "expired" is a render-time derivation. This is the architectural pattern OpenClaw doesn't have at all.
- **Bounded sweep batches** (default 100 emissions/run) prevent stampedes after downtime.

**Why Instar's is more evolved**: OpenClaw's commitment is a follow-up reminder. Instar's commitment is a structured promise with declared mechanism, named counterparty, tiered resolution provenance, supersedes-based history, dispute lane, and signal-shaped lifecycle observation. Importing OpenClaw's flat shape would erase the mechanism-spec, resolution-tier, and supersedes-based audit trail. **Do not import.**

What we CAN learn from OpenClaw's version: the `HEARTBEAT_OK` dismissal grammar (a typed in-band response that closes the loop without natural-language ambiguity), and the "≥1 heartbeat clamp" so an inferred commitment can never echo back in the same moment it's inferred. Both are small additions that don't compromise the v2 ledger model.

### 9.2 Heartbeat — different concept entirely

OpenClaw heartbeat is a **delivery channel**: due commitments and background prompts are folded into a heartbeat turn for the same agent and channel scope (`docs/concepts/commitments.md:64-77`).

Instar heartbeat is a **multi-machine consensus primitive** (`src/core/HeartbeatManager.ts:1-90`): the awake machine broadcasts every 2 minutes; standby machines monitor and auto-failover after 15 minutes of silence; split-brain detection is via cross-heartbeat processing; failover is rate-limited (cooldown 30m, max 3/24h) and can require human confirmation. Different problem space — **do not conflate or replace.**

If Instar wants OpenClaw-style "due-commitment delivery during idle turns," that's a separate sweeper that runs on a timer, NOT a refactor of HeartbeatManager.

### 9.3 Memory backend — typed entity graph beats Markdown files

OpenClaw memory primary is **Markdown files** (`MEMORY.md`, `memory/YYYY-MM-DD.md`, `DREAMS.md`) with pluggable SQLite/QMD/Honcho/LanceDB *backends* for search (`docs/concepts/memory.md:9-23`).

Instar memory primary is **a typed entity graph** in SQLite + JSONL (`src/core/types.ts:2580-2629`, `src/memory/SemanticMemory.ts:58`):
- Native typed entities (`fact | person | project | tool | pattern | decision | lesson`) with confidence scores, temporal metadata (`createdAt / lastVerified / lastAccessed / expiresAt`), provenance, tags, domains, owner, privacy scope.
- Native typed edges (`built_by / depends_on / supersedes / contradicts / part_of / used_in / knows_about / caused / verified_by`) with weights and contexts.
- Hybrid FTS5 + sqlite-vec search.
- JSONL append log alongside the DB as disaster-recovery source-of-truth.
- Per-entity `privacyScope` for multi-user isolation.
- Confidence decay job + hard `expiresAt` per entity.

**Why Instar's is more evolved**: relationship traversal is native ("who built X?", "what depends on Y?", "what does this contradict?"). OpenClaw's WikiClaim layer adds claim-level provenance ON TOP of Markdown but cannot answer graph queries. The `supersedes` relation type lets Instar maintain fact lineage automatically; OpenClaw's contradiction tracking lives in WikiClaim metadata, not as queryable graph edges. **Do not migrate to Markdown-primary memory.**

What we DO want from OpenClaw: WikiClaim's `evidence: [...]` array as a richer alternative to the current `source: string` field on `MemoryEntity` (see §8 #2). And dreaming's six-signal score (see §8 #3). Both add to the typed-graph model rather than replacing it.

### 9.4 Active memory — adopt as a hook, not as a memory model

OpenClaw active memory is a *plugin-owned blocking sub-agent* (`extensions/active-memory/index.ts`, 3042 lines) that runs `before_prompt_build` to inject a hidden prompt prefix.

Instar already does **continuous, structurally-budgeted, multi-source assembly** at session start via `WorkingMemoryAssembler` (`src/memory/WorkingMemoryAssembler.ts:97`):
- Default budgets: `knowledge:800, episodes:400, relationships:300, total:2000` tokens.
- Multi-source: SemanticMemory entities + EpisodicMemory digests + relationship/people context.
- Render strategy: top-3 full / next-7 compact / remainder name-only.
- Trigger-aware: parses prompt + jobSlug + topicId.

**Why Instar's is more evolved**: OpenClaw active-memory is a single bounded recall pass with one tool surface (`memory_recall/search/get`). Instar working-memory is multi-source, multi-format, and budget-aware. Importing OpenClaw's plugin model wholesale would replace a richer assembly with a narrower recall.

What we DO want: the per-turn `before_prompt_build` HOOK as a graft surface for ADDITIONAL recall before reply (e.g., "we already loaded baseline context at session start; for this specific user message, also pull the 3 most relevant fact entities"). That's an *augmentation*, not a replacement.

### 9.5 Signal-vs-authority architecture is uniquely Instar

OpenClaw has many gates (queue, hooks, exec-approvals, tool-call hooks) but none of them are explicitly architected as **signal-emitters subordinate to a single authority**. OpenClaw's `before_tool_call` returning `{block: true}` IS terminal — that's a low-context decision with blocking authority, exactly the pattern Justin's signal-vs-authority doc forbids.

Instar's pattern (`docs/signal-vs-authority.md`, repeatedly cited across `LedgerParaphraseDetector.ts`, `OutboundDedupGate.ts`, `CommitmentSweeper.ts`, `MessageSentinel.ts`): brittle/low-context detectors emit *signals*; only a higher-level intelligent gate with full context has *blocking authority*.

Concrete: `LedgerParaphraseDetector` (`src/core/LedgerParaphraseDetector.ts:3-19`) is "SIGNAL ONLY. NEVER blocks. The MessagingToneGate remains the single authority." Same shape for `OutboundDedupGate`, `CommitmentSweeper` (sweepers emit notes, never mutate), `MessageSentinel` (classifies → emits action recommendation; the AgentServer applies the action).

**Do not import** OpenClaw's `before_tool_call: {block:true}` pattern as the model for Instar's tool gating. Instar's architecture would treat that as a low-context detector promoting itself to authority — exactly the pattern that produced the email-deletion incident OpenClaw is named in.

### 9.6 MessageSentinel — a primitive OpenClaw doesn't have

OpenClaw has session diagnostics (`session.long_running / stalled / stuck`) for self-diagnosis (`docs/concepts/agent-loop.md:168`) and queue modes for user-message handling (`docs/concepts/queue.md`), but it does NOT have an out-of-process classifier that intercepts user messages BEFORE the session sees them.

Instar's `MessageSentinel` (`src/core/MessageSentinel.ts:1-78`) explicitly cites the OpenClaw email-deletion incident as origin: "the user typed 'STOP' repeatedly but the agent continued deleting emails because messages queued in the session's input buffer." Sentinel runs in the server process, classifies via fast-path regex (≤MAX_FAST_PATH_WORDS, <5ms) + LLM Haiku-tier (<500ms) → `kill-session | pause-session | priority-inject | pass-through`. ContinuePingIntent (`intent_a/b/c`) provides gate-quality telemetry distinguishing "operator manually unblocked" from "operator added scope" from "operator asked verification."

**This is a primitive OpenClaw should arguably import FROM Instar.** It is not currently in OpenClaw's source as far as Dawn's audit and my code-skim showed. **Do not downgrade by importing OpenClaw's queue-mode-as-stop-handling pattern.**

### 9.7 ExternalOperationGate — three-tier risk evaluation

OpenClaw exec-approvals (`docs/concepts/exec-approvals.md`) are a binary "approve / deny shell command" prompt with allowlist patterns. No risk classification, no per-service trust, no LLM proportionality evaluation.

Instar's `ExternalOperationGate` (`src/core/ExternalOperationGate.ts:1-22`):
1. Static classification — `mutability × reversibility × scope → risk level`
2. Config permissions — per-service allow/block (structural floor)
3. LLM evaluation — for medium+ risk, Haiku-tier evaluates proportionality
4. Integrated with AdaptiveTrust for organic permission evolution

**Why Instar's is more evolved**: deletes are first-class differentiated from reads via static classification. A 200-email deletion classifies as `delete × irreversible × bulk → critical risk` BEFORE any LLM call, and the LLM only fires for medium+ risk decisions. OpenClaw's binary approve/deny treats `rm -rf .` and `ls .` the same shape and relies on operator vigilance plus pattern matching. **Do not import** OpenClaw's exec-approvals shape as a model.

### 9.8 Multi-machine coordination — Instar has it, OpenClaw doesn't

OpenClaw is single-host: "Exactly one Gateway controls a single Baileys session per host" (`docs/concepts/architecture.md:144`).

Instar has full multi-machine: `HeartbeatManager` (broadcast/monitor/failover), `JobClaimManager` (cross-machine job dedup, `src/scheduler/JobClaimManager.ts:97`), `MachineIdentity`, `MultiMachineCoordinator`, `MachineRole`, split-brain detection, failover rate-limiting (cooldown 30m, max 3/24h), graceful handoff coordination, git-sync as transport for cross-machine state.

**Do not import** anything from OpenClaw to "fix" Instar multi-machine — there's nothing to fix there. OpenClaw's architecture explicitly assumes one-host, and importing patterns from a single-host runtime would degrade the multi-machine layer. (Worth offering TO OpenClaw if Dawn wants it.)

### 9.9 Coherence + project-binding — uniquely Instar

OpenClaw has agent isolation via per-agent workspaces and bindings, but no coherence-check-before-action layer. Multiple agents can act in their own scopes, but there is no "you may be in the wrong project for this topic" gate.

Instar's `CoherenceGate` (`src/core/CoherenceGate.ts:159`) + topic-project bindings + ScopeCoherenceTracker provide a pre-action grounding pause: before deploying / pushing / modifying files outside the project, the gate runs `POST /coherence/check` with the topic context and answers `allow | warn | block`. This catches the cross-project confusion that an agent juggling many projects naturally drifts into.

**Do not import** any "binding-as-routing" model from OpenClaw to replace this — they're solving different problems. OpenClaw bindings route inbound messages; Instar coherence binding gates outbound action.

### 9.10 OutboundDedupGate / LedgerParaphraseDetector — deterministic safety nets

OpenClaw has session-write-locks and run serialization to prevent two runs from racing in the same session, but no outbound-message-content dedup. If two independent agent paths produce near-identical replies (e.g., context-exhaustion respawn racing with an in-flight reply), OpenClaw will send both.

Instar's `OutboundDedupGate` (Jaccard 3-gram, threshold 0.7, 5m window, 40-char min, sub-millisecond) catches this structurally. `LedgerParaphraseDetector` (Jaccard word-set, threshold 0.7, 50-entry window, signal-only) catches the related case where the agent paraphrases something it already said TO A DIFFERENT counterparty.

**Do not import** OpenClaw's session-write-lock as a substitute for outbound content dedup — they catch different failure modes. The session-write-lock prevents concurrent transcript writes; the dedup gate catches semantic duplicates regardless of how they entered the outbound queue.

### 9.11 Playbook + ContextHierarchy + WorkingMemoryAssembler — context engineering

OpenClaw context engineering is system-prompt assembly + active-memory recall + bootstrap files (`docs/concepts/agent-loop.md:69-88`). Solid, but flat in shape — system prompt is one rendered string per turn.

Instar context is **tiered + scored + lifecycle-managed**:
- `ContextHierarchy` with tier-0 (identity/safety/project), tier-1 (session/relationships), tier-2 (development/deployment/communication/architecture/research) segments.
- `Playbook` with scored items, triggers, decay, dedup, cross-agent mount with integrity verification.
- `WorkingMemoryAssembler` for token-budgeted multi-source assembly.
- Context dispatch table (when X arises, read Y).

**Do not import** OpenClaw's flat system-prompt model as a model for "simplifying" Instar context. The tiered model is the design — it's how Instar avoids context-window pressure without losing identity continuity.

### 9.13 Agent-identity discovery — MoltBridge beats bindings/identityLinks

OpenClaw cross-channel identity is `session.identityLinks` (`docs/concepts/channel-docking.md:60-80`): a static config block mapping a canonical key to channel-prefixed peer ids (`telegram:123`, `discord:456`, `slack:U123`). Used for docking commands; doesn't address agent-to-agent discovery.

Instar's MoltBridge (`src/moltbridge/types.ts:1-70`) is a three-tier rich-agent-profile system:
- **Tier 1 Discovery Card** (≤1KB): `agentId, name, platform, narrativeSummary, trustScore, capabilities, profileCompletenessScore, profileUrl, a2aEndpoint`.
- **Tier 2 Full Profile**: narrative (max 500 chars), specializations (typed level: expert / advanced / working with evidence URLs), trackRecord (commit hashes, attestation IDs), roleContext, collaborationStyle, differentiation.
- **Tier 3 Deep**: per-field visibility (`public | registered | trusted | private`), first-party vs attested claim separation.
- Content-hash freshness tracking; structured signals extracted by rule-based pipeline (no LLM) — `commitStats`, `projectNames`, `jobNames`, `capabilityNames`, `roleHints`.

**Why Instar's is more evolved**: agent-to-agent discovery is a first-class concern with progressive disclosure, not a config block. First-party-vs-attested claim separation is the same pattern WikiClaim uses for facts, applied to agent identity. **Do not import** OpenClaw's identityLinks as a substitute — it solves a different problem (cross-channel routing for one user) than agent-introduction (Echo introducing themselves to Dawn over Threadline).

### 9.14 Identity-as-injected-files plus structural recovery hooks

Both runtimes inject identity files into prompts: OpenClaw injects `AGENTS.md / SOUL.md / TOOLS.md / IDENTITY.md / USER.md / BOOTSTRAP.md` (`docs/concepts/agent.md:27-42`); Instar injects `AGENT.md / USER.md / MEMORY.md` plus tier-0 context segments. Comparable on the file-injection model.

**Where Instar diverges**: identity hooks (`session-start.sh`, `compaction-recovery.sh`) fire automatically via Claude Code's SessionStart hook system to re-inject identity content when context is compacted mid-session. OpenClaw's identity files are loaded "on the first turn of a new session" (`docs/concepts/agent.md:36`); after compaction they're not re-injected unless they were summarized into the compaction artifact.

**Why Instar's is more evolved for the compaction case**: the compaction-recovery hook means Echo's name, principles, and memory survive a context-window crash structurally — not by hoping the compaction summary preserved them. **Do not import** OpenClaw's "load on first turn only" model.

### 9.15 Topic-thread mapping for symmetric naming

OpenClaw `session.identityLinks` map peers across channels (Telegram:123 ↔ Discord:456). Useful for docking, doesn't address topic-naming symmetry.

Instar's TopicResumeMap, ContextThreadMap, and the symmetric topic-id convention (Echo's topic 9003 mirrors Dawn's topic 9003 for the same conversation) let two agents discuss the same thread by id without renegotiation. Threadline relay carries `thread-2ebce60b` ids that both agents key off.

**Do not import** OpenClaw's `identityLinks` as a substitute — they solve a different problem (one user, multiple channels) than topic-symmetric naming (two agents, same conversation).

### 9.16 Delegate architecture is a parity item, not an Instar-more-evolved one

OpenClaw delegate architecture (`docs/concepts/delegate-architecture.md:1-60`) lets an agent act on behalf of humans in an organization with its own identity (email, calendar, display name) and three capability tiers (read-only+draft / send-on-behalf / full-autonomy). Identity-provider permissions act as a structural floor independent of OpenClaw's tool policy.

Instar's user-agent topology (`PrivacyScopeType` per `MemoryEntity`, `ownerId` per entity, multi-user support in `src/users/`) covers comparable ground for *data scope* — entities are owned by users, agents respect privacy scopes — but Instar does not have a built-in identity-provider integration that maps "Echo emails on behalf of Justin" to a third-party identity (e.g., Google Workspace delegation). **This is a parity gap, not an Instar-more-evolved item.** When Instar moves into organizational deployments, OpenClaw's delegate model is a reasonable reference; today it's not a competitive distinction.

I'm leaving this in §9 explicitly because it's a place where the surface looks similar but Instar isn't more evolved — the honest read matters more than padding the count.

---

## §10 Open questions for Instar

Mirroring Dawn's 15 open-questions structure. Most are echoes of Dawn's or follow-ups specifically about Instar.

1. **Should Instar's bug-cluster pipeline migrate to managed TaskFlow?** Cost: replacing `EvolutionManager` ad-hoc state with a typed flow. Benefit: optimistic-concurrency mutations, typed wait reasons, controller-owned lifecycle. Risk: BEGIN-IMMEDIATE caching means we can't have multiple processes writing to the same flow state without a registry-refresh API.

2. **Where should WikiClaim-style evidence arrays live?** As a new `evidence?: WikiEvidence[]` field on `MemoryEntity`, or as a separate `MemoryClaim` table joined to entities? The first preserves the typed graph; the second matches OpenClaw's WikiClaim isolation but adds a join.

3. **Is the dreaming six-signal score the right model for PROP promotion, or just an inspiration?** Instar's signal-vs-authority pattern would prefer the score to be a SIGNAL fed to an intelligent promoter, not a hard gate.

4. **Should Instar add an `before_prompt_build`-shaped hook?** Today, working-memory assembly happens at session start. Adding a per-turn pre-reply hook means another LLM call per inbound message — the same latency cost OpenClaw warns about (`docs/concepts/active-memory.md:481-483`). Worth the cost for sentiment / continuity / preference-recall passes?

5. **Multi-channel queue modes**: Instar's per-topic processing collapses many message arrivals into "process the queue when next run." Do we want explicit `steer / collect / followup / steer-backlog` semantics, or is collapse acceptable for the single-agent case?

6. **Cold-start grace knob**: Instar has no equivalent. When intelligence-provider sub-agents (Sentinel, OperationGate, CoherenceReviewer) cold-start, should there be an explicit `setupGraceTimeoutMs` separate from the operation timeout? Today, every blocking call uses the same timeout.

7. **Diagnostics state machine for sessions**: OpenClaw's `long_running / stalled / stuck` taxonomy with abort-drain at ≥5× warn threshold is well-shaped. Should Instar adopt this verbatim for session telemetry?

8. **Channel docking command**: when Instar moves to multi-channel routine use, do we want OpenClaw-style `/dock_<channel>` from session, or topic-binding rebind via API?

9. **FallbackSummaryError**: should Instar add structured fallback-summary errors to intelligence-provider failures? Cost is small; observability gain is large.

10. **HEARTBEAT_OK dismissal grammar**: should Instar's commitment subsystem expose a typed in-band "no further action needed" response, distinct from natural-language reply? (Instar's resolution tiers cover the mechanism; HEARTBEAT_OK covers the user-side dismissal grammar.)

11. **Sub-agent transcript persistence directory**: Echo's sub-agents (Explore, Plan, etc.) persist transcripts where? Today they live alongside main session transcripts; should they live in a separate `.instar/sub-agent-sessions/` for replay debugging?

12. **Codex-style harness selection for Echo's sub-agents**: should "use Claude Sonnet for Plan, Haiku for ToolSearch" be expressible via something like OpenClaw's `agentRuntime.id` selector + auto-claim policy?

13. **Auth-profile rotation**: if Instar adds multi-key fallback for outage resilience, do we want OpenClaw's profile-stickiness-per-session model (cache warmth) or pure round-robin?

14. **Dispute pointer surface**: Instar's `LedgerEntry.disputes?` field exists. Is there a UI / CLI surface for "I dispute this commitment" or is it write-only today?

15. **Multi-agent collaboration on a shared TaskFlow**: if Instar imports TaskFlow, can Echo + Dawn collaborate on one flow via Threadline? `controllerId=Echo` plus `setFlowWaiting({waitJson:{kind:"reply", who:"dawn", thread:"thread-2ebce60b"}})` is the obvious shape, but the cross-agent revision-conflict semantics are non-trivial.

---

## Closing note for Justin

Echo's read: importing TaskFlow + WikiClaim evidence + dreaming's promotion gates would be high-leverage, low-risk additions that respect Instar's existing architecture. Importing anything that would replace SharedStateLedger commitments, AdaptiveTrust, MessageSentinel, ExternalOperationGate, the typed-entity memory graph, the multi-machine layer, or the signal-vs-authority pattern would be a downgrade. §9 enumerates each case explicitly so future agents reading this audit don't accidentally regress.

Per Dawn's coordination note, this audit will be shared back via Threadline `thread-2ebce60b` with §9 highlighted, and Dawn's per-feature specs will arrive as she produces them.
