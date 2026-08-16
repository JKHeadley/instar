---
source: Dawn (workstation, threadline agent 8c7928aa9f04fbda947172a2f9b2d81a)
received: 2026-05-07
thread: thread-2ebce60b
purpose: Handoff context for Echo to produce parallel OpenClaw->Instar audit
status: research-context
---

# OpenClaw Audit Handoff — Dawn → Echo

Dawn produced an audit of OpenClaw (~/Documents/Projects/openclaw-study, tagged v2026.5.6, ~30,500 commits since Feb 16). Justin's ask: replicate this depth for Instar, with explicit §9 calling out where Instar is more evolved (do NOT downgrade).

Full audit lives on workstation: `.claude/research/openclaw-audit-2026-05-07.md` (756 lines, 22 primitives, 15 open questions). Justin has it via Telegram file viewer.

## Top 6 Stealable Primitives (verbatim from Dawn)

### 1. TaskFlow record
- File: `src/tasks/task-flow-registry.types.ts:14-43`
- Shape: `{flowId, syncMode, ownerKey, controllerId, revision, status, notifyPolicy, goal, currentStep, blockedTaskId, stateJson, waitJson, ...}`
- Optimistic concurrency on every mutation via `expectedRevision`
- Lifecycle: `createManaged -> runTask -> setWaiting({waitJson:{kind:"reply"|"human-review"|"external-call"}}) -> resume -> finish`
- SQLite-backed, survives Gateway restart
- **For Instar**: convert Echo-controlled bug-cluster pipeline into managed flows. controllerId=Echo, goal=cluster, currentStep=bug-fix advance, "waiting on Justin to ratify" = `setWaiting({waitJson:{kind:"human-review",who:"Justin",topic:21721}})`

### 2. WikiClaim provenance schema
- File: `extensions/memory-wiki/src/markdown.ts:17-101`
- Shape: `{text, status, confidence, evidence:[{sourceId, path, lines, weight, confidence, privacyTier, note}]}`
- **For Instar**: every bug cluster carries `{claims:[{text, evidence:[{sourceId:feedback_id, lines:...}]}]}` so auto-fix decisions trace back to specific reports rather than to a clustered summary.

### 3. Commitments
- File: `docs/concepts/commitments.md`
- Typed memory layer between Memory and Cron
- Hidden background extraction pass after each agent reply detects inferred follow-ups, stores `{agentId, sessionKey, channel, dueWindow, suggestedCheckin}`
- Delivered via heartbeat; clamp: never delivered immediately after writing — minimum one heartbeat after creation
- Model can send check-in OR reply HEARTBEAT_OK to dismiss
- CLI: `openclaw commitments`, `dismiss cm_abc123`, `--status snoozed`
- Dawn's verdict: "most original primitive in the codebase"
- **For Instar**: right shape for "Echo noticed something during a session that should follow up later"

### 4. Active-memory pre-reply recall sub-agent
- File: `extensions/active-memory/index.ts` (3042 lines)
- `before_prompt_build` hook runs bounded sub-agent before every eligible reply
- Tool allowlist: `[memory_recall, memory_search, memory_get]`
- Six prompt styles (balanced, strict, contextual, recall-heavy, precision-heavy, preference-only)
- Circuit breaker: 3 timeouts → 60s cooldown
- Cache TTL: 1-120s
- Returns NONE if connection is weak
- Cold-start grace knob (`setupGraceTimeoutMs`) added v2026.5.2
- **For Instar**: any agent loop doing grounding-before-reply could collapse N grounding skills into one bounded pre-reply pass

### 5. Dreaming six-signal weighted score
- File: `docs/concepts/dreaming.md:99-107`
- Weights: Frequency .24 / Relevance .30 / Diversity .15 / Recency .15 / Consolidation .10 / Richness .06
- Promotion gates: `minScore + minRecallCount + minUniqueQueries`
- Three phases (Light/Deep/REM); only Deep writes durably
- **For Instar**: feedback cluster → PROP queue promotion could use same gates so clusters need both frequency AND query-diversity before becoming a PROP

### 6. llm-task JSON-only tool
- File: `extensions/llm-task/src/llm-task-tool.ts`
- Single Ajv-validated structured-output primitive
- Params: `prompt, input, schema, provider, model, thinking, authProfileId, temperature, maxTokens, timeoutMs`
- "No tools are exposed to the model for this run"
- Designed to be called from Lobster workflows via `openclaw.invoke --each`
- **For Instar**: cluster severity scorer / dispatch decider should be a single typed JSON tool, not an inline prompt

## Other Notable Primitives

- model-failover with auth-profile rotation + cooldown buckets
- channel-docking primitive (move session between channels without losing transcript)
- session-pruning vs compaction distinction
- parallel specialist lanes with explicit lane contracts
- diagnostics state machine (long_running/stalled/stuck)
- commitment-style HEARTBEAT_OK dismissal protocol
- soul.md as injected file (not just lore)

## Recipe for Echo's Audit

1. Clone openclaw fresh: `cd ~/projects && git clone https://github.com/openclaw/openclaw openclaw-study && cd openclaw-study && git log -1 --oneline` (should be at `f482e4d335` or later)
2. Read concept docs (priority eight): architecture.md, agent-loop.md, agent-runtimes.md, active-memory.md, memory.md, multi-agent.md, queue.md, model-failover.md, channel-docking.md, commitments.md
3. Code-skim: `extensions/active-memory/`, `extensions/memory-wiki/`, `extensions/memory-core/`, `extensions/llm-task/`, `src/tasks/`, `skills/taskflow/`, `skills/taskflow-inbox-triage/`, one provider extension (`extensions/codex/`), one channel extension (`extensions/telegram/`)
4. Output: `.claude/research/openclaw-audit-instar-<date>.md` with same 10 sections:
   1. Architecture overview
   2. TaskFlow
   3. Memory architecture
   4. Multi-provider routing
   5. Channel runtime
   6. Permissions/retries/sub-agents/sessions
   7. Surprises
   8. Primitives worth importing for INSTAR
   9. **Things NOT to import (where Instar is more evolved)** — most important section per Justin
   10. Open questions for Instar
5. **§9 is the most important.** For each OpenClaw primitive, compare against what Instar already has (bug-cluster pipeline, Tier-1/Tier-2 flow, dispatch logic). Don't downgrade.

## Top 3 Open Questions for Instar (out of 15)

1. **TaskFlow's revision-conflict guarantees** — SQLite atomic across processes, or single-process only? (Determines whether Instar's pipeline can run multi-process safely.)
2. **Lobster DSL composition with TaskFlow** — `skills/taskflow/examples/inbox-triage.lobster` — determines whether Instar needs an external workflow language or can stay in TS.
3. **`before_prompt_build` hook signature** — `prependContext` / `prependSystemContext` / `appendSystemContext` semantics — exact graft surface for an active-memory analog in Instar's agent loop.

Dawn is digging into all 15 questions on her side and writing per-feature specs (one spec per primitive, audit-grade, calling out where Dawn is more evolved). Will share via Threadline as produced.

## Coordination

- Telegram topic created on Instar side: **OpenClaw** (message_thread_id=9003, created 2026-05-07)
- Justin will collaborate with Echo in topic 9003
- Reply to Dawn via threadline thread-2ebce60b for cross-agent collab
